import "server-only";

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  FinancialRecordKind,
  ImportKind,
  ImportRowStatus,
  ImportStatus,
  Prisma,
  RefundStatus,
  ReturnStatus,
} from "@prisma/client";
import { prisma } from "../db";
import { MappingSuggestionInputError, recordMappingSuggestionDecision } from "./ai-mapping";
import { maskPersonalData, previewSourceFile, readSourceRows, type SourceRow } from "./files";
import { OrderCopyWriter } from "./order-copy";
import { putImportFile, withImportFile } from "./storage";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK_SIZE = 10_000;

export type ImportChunkProfile = {
  rows: number;
  normalizationMs: number;
  duplicateDetectionMs: number;
  existingRowsQueryMs: number;
  serializationMs: number;
  stageCopyMs: number;
  orderInsertMs: number;
  importRowsCopyMs: number;
  transactionMs: number;
};

export type ImportProfile = {
  csvReadMs: number;
  chunks: ImportChunkProfile[];
};

export class ImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportConflictError";
  }
}

export class ImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportInputError";
  }
}

export type ColumnMapping = Record<string, string>;

type NormalizedRow = {
  data: Record<string, string | number | boolean | null>;
  errors: string[];
  deduplicationKey?: string;
};

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileExtension(fileName: string): "csv" | "xlsx" {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".csv") return "csv";
  if (extension === ".xlsx") return "xlsx";
  throw new ImportInputError("Only CSV and XLSX files are supported.");
}

function validateMapping(
  kind: ImportKind,
  mapping: ColumnMapping,
  headers: string[],
): string[] {
  const requiredByKind: Record<ImportKind, string[]> = {
    ORDER: ["externalId", "orderDate", "orderValue", "paymentMethod", "deliveryStatus"],
    SETTLEMENT: ["transactionDate", "netAmount"],
    COD_REMITTANCE: ["transactionDate", "netAmount"],
    FREIGHT_INVOICE: ["transactionDate", "feeAmount"],
    RETURN_RECEIPT: ["externalOrderId", "expectedReceiptAt"],
    REFUND: ["orderId", "transactionDate", "netAmount", "expectedAmount"],
  };
  const errors = requiredByKind[kind]
    .filter((field) => !mapping[field])
    .map((field) => `A column must be mapped to "${field}".`);
  for (const [field, header] of Object.entries(mapping)) {
    if (header && !headers.includes(header)) {
      errors.push(`Mapped column "${header}" for "${field}" is not in this file.`);
    }
  }
  const assignedHeaders = Object.values(mapping).filter(Boolean);
  if (new Set(assignedHeaders).size !== assignedHeaders.length) {
    errors.push("A source column cannot be mapped to more than one field.");
  }
  return errors;
}

function valueFor(row: SourceRow, mapping: ColumnMapping, key: string): string {
  const header = mapping[key];
  return header ? (row[header] ?? "").trim() : "";
}

function parseDate(value: string, label: string, errors: string[]): Date | null {
  if (!value) {
    errors.push(`${label} is required.`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push(`${label} must be a valid ISO date or timestamp.`);
    return null;
  }
  return date;
}

function parseMoney(
  value: string,
  label: string,
  errors: string[],
  options: { required?: boolean; nonnegative?: boolean } = {},
): string | null {
  if (!value) {
    if (options.required) errors.push(`${label} is required.`);
    return options.required ? null : "0.00";
  }
  const normalized = value.replace(/,/g, "").replace(/^₹\s*/, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    errors.push(`${label} must be a decimal amount with at most two fractional digits.`);
    return null;
  }
  const decimal = new Prisma.Decimal(normalized);
  if (options.nonnegative && decimal.lt(0)) {
    errors.push(`${label} cannot be negative.`);
    return null;
  }
  return decimal.toFixed(2);
}

function normalizedRow(
  kind: ImportKind,
  raw: SourceRow,
  mapping: ColumnMapping,
  rowNumber: number,
): NormalizedRow {
  const errors: string[] = [];
  const data: NormalizedRow["data"] = { sourceRowNumber: rowNumber };
  const currencyRaw = valueFor(raw, mapping, "currency").toUpperCase() || "INR";
  if (!/^[A-Z]{3}$/.test(currencyRaw)) errors.push("Currency must be a three-letter ISO code.");

  if (kind === ImportKind.ORDER) {
    const externalId = valueFor(raw, mapping, "externalId");
    if (!externalId || externalId.length > 120) {
      errors.push("Order ID is required and must be at most 120 characters.");
    }
    const orderDate = parseDate(valueFor(raw, mapping, "orderDate"), "Order date", errors);
    const orderValue = parseMoney(valueFor(raw, mapping, "orderValue"), "Order value", errors, {
      required: true,
      nonnegative: true,
    });
    const paymentMethod = valueFor(raw, mapping, "paymentMethod").toUpperCase();
    const deliveryStatus = valueFor(raw, mapping, "deliveryStatus").toUpperCase().replaceAll(" ", "_");
    if (!["COD", "PREPAID"].includes(paymentMethod)) {
      errors.push("Payment method must be COD or PREPAID.");
    }
    if (!["PLACED", "SHIPPED", "DELIVERED", "RETURN_TO_WAREHOUSE", "CANCELLED"].includes(deliveryStatus)) {
      errors.push("Delivery status is not supported.");
    }
    Object.assign(data, {
      externalId,
      orderDate: orderDate?.toISOString() ?? null,
      orderValue,
      currency: currencyRaw,
      paymentMethod,
      deliveryStatus,
      deliveredAt: valueFor(raw, mapping, "deliveredAt") || null,
      settlementDueAt: valueFor(raw, mapping, "settlementDueAt") || null,
    });
    return { data, errors, deduplicationKey: externalId };
  }

  if (kind === ImportKind.RETURN_RECEIPT) {
    const externalOrderId = valueFor(raw, mapping, "externalOrderId");
    if (!externalOrderId || externalOrderId.length > 120) {
      errors.push("Return order ID is required and must be at most 120 characters.");
    }
    const expectedReceiptAt = parseDate(
      valueFor(raw, mapping, "expectedReceiptAt"),
      "Expected receipt date",
      errors,
    );
    const receivedRaw = valueFor(raw, mapping, "receivedAt");
    const receivedAt = receivedRaw ? parseDate(receivedRaw, "Received date", errors) : null;
    const warehouseReceiptReference = valueFor(raw, mapping, "warehouseReceiptReference");
    Object.assign(data, {
      externalOrderId,
      expectedReceiptAt: expectedReceiptAt?.toISOString() ?? null,
      receivedAt: receivedAt?.toISOString() ?? null,
      warehouseReceiptReference: warehouseReceiptReference || null,
    });
    return {
      data,
      errors,
      deduplicationKey: `${externalOrderId}:${warehouseReceiptReference || "expected"}`,
    };
  }

  const orderId = valueFor(raw, mapping, "orderId");
  if (orderId.length > 120) errors.push("Order ID must be at most 120 characters.");
  const transactionDate = parseDate(
    valueFor(raw, mapping, "transactionDate"),
    "Transaction date",
    errors,
  );
  const externalReference = valueFor(raw, mapping, "externalReference");
  if (externalReference.length > 180) errors.push("Transaction reference must be at most 180 characters.");
  const grossAmount = parseMoney(valueFor(raw, mapping, "grossAmount"), "Gross amount", errors, {
    nonnegative: true,
  });
  const feeAmount = parseMoney(valueFor(raw, mapping, "feeAmount"), "Fee amount", errors, {
    nonnegative: true,
  });
  const tcsAmount = parseMoney(valueFor(raw, mapping, "tcsAmount"), "TCS amount", errors, {
    nonnegative: true,
  });
  const tdsAmount = parseMoney(valueFor(raw, mapping, "tdsAmount"), "TDS amount", errors, {
    nonnegative: true,
  });
  const netField = kind === ImportKind.FREIGHT_INVOICE ? "feeAmount" : "netAmount";
  const netAmount = kind === ImportKind.FREIGHT_INVOICE
    ? feeAmount
    : parseMoney(valueFor(raw, mapping, "netAmount"), "Net amount", errors, { required: true });
  const billedWeightKg = valueFor(raw, mapping, "billedWeightKg");
  if (billedWeightKg && !/^\d+(?:\.\d{1,3})?$/.test(billedWeightKg)) {
    errors.push("Billed weight must be a nonnegative decimal with at most three fractional digits.");
  }
  const expectedAmount =
    kind === ImportKind.REFUND
      ? parseMoney(valueFor(raw, mapping, "expectedAmount"), "Expected refund", errors, {
          required: true,
          nonnegative: true,
        })
      : null;
  Object.assign(data, {
    orderId: orderId || null,
    externalReference: externalReference || null,
    transactionDate: transactionDate?.toISOString() ?? null,
    currency: currencyRaw,
    grossAmount,
    feeAmount,
    tcsAmount,
    tdsAmount,
    netAmount,
    billedWeightKg: billedWeightKg || null,
    expectedAmount,
    financialKind:
      kind === ImportKind.SETTLEMENT
        ? FinancialRecordKind.SETTLEMENT
        : kind === ImportKind.COD_REMITTANCE
          ? FinancialRecordKind.COD_REMITTANCE
          : kind === ImportKind.FREIGHT_INVOICE
            ? FinancialRecordKind.FREIGHT_INVOICE
            : FinancialRecordKind.REFUND,
    netField,
  });
  return {
    data,
    errors,
    deduplicationKey:
      externalReference || hash(JSON.stringify({ row: raw, rowNumber })),
  };
}

function maskRawRow(row: SourceRow): Prisma.InputJsonObject {
  return maskPersonalData(row) as Prisma.InputJsonObject;
}

export async function uploadImportPreview(input: {
  partnerCode: string;
  kind: ImportKind;
  sourceKey: string;
  fileName: string;
  file: Buffer;
  uploadedById: string;
}) {
  if (input.file.byteLength === 0 || input.file.byteLength > MAX_FILE_BYTES) {
    throw new ImportInputError("The file must be between 1 byte and 50 MB.");
  }
  if (!input.sourceKey.trim() || input.sourceKey.length > 120) {
    throw new ImportInputError("Source key is required and must be at most 120 characters.");
  }
  const extension = fileExtension(input.fileName);
  if (extension === "xlsx" && !(input.file[0] === 0x50 && input.file[1] === 0x4b)) {
    throw new ImportInputError("The XLSX file signature is invalid.");
  }
  const contentHash = hash(input.file);
  const partner = await prisma.partner.findUnique({
    where: { code: input.partnerCode },
    select: { id: true },
  });
  if (!partner) throw new ImportInputError("Partner code was not found.");

  const source = await prisma.importSource.upsert({
    where: {
      partnerId_kind_sourceKey: {
        partnerId: partner.id,
        kind: input.kind,
        sourceKey: input.sourceKey.trim(),
      },
    },
    create: {
      partnerId: partner.id,
      kind: input.kind,
      sourceKey: input.sourceKey.trim(),
    },
    update: {},
  });
  const existing = await prisma.importBatch.findUnique({
    where: { sourceId_contentHash: { sourceId: source.id, contentHash } },
    select: {
      id: true,
      status: true,
      totalRows: true,
      acceptedRows: true,
      rejectedRows: true,
      duplicateRows: true,
    },
  });
  if (existing) {
    return { ...existing, duplicateUpload: true };
  }

  const storageKey = `${contentHash}.${extension}`;
  await putImportFile(storageKey, input.file);
  const preview = await withImportFile(storageKey, async (filePath) => {
    try {
      return await previewSourceFile(filePath, extension);
    } catch (error) {
      throw new ImportInputError(
        `Could not parse uploaded file: ${error instanceof Error ? error.message : "unknown parser error"}`,
      );
    }
  });
  if (preview.totalRows === 0) throw new ImportInputError("The file contains headers but no data rows.");

  const previewHash = hash(JSON.stringify({ headers: preview.headers, rows: preview.rows }));
  const batch = await prisma.importBatch.create({
    data: {
      sourceId: source.id,
      uploadedById: input.uploadedById,
      fileName: input.fileName.replace(/[\u0000-\u001f]/g, "").slice(0, 255),
      storageKey,
      contentHash,
      fileSizeBytes: BigInt(input.file.byteLength),
      status: ImportStatus.PREVIEWED,
      totalRows: preview.totalRows,
      previewHeaders: preview.headers as Prisma.InputJsonArray,
      previewRows: preview.rows.slice(0, 20).map(maskRawRow) as Prisma.InputJsonArray,
      previewHash,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: input.uploadedById,
      action: "IMPORT_UPLOADED",
      entityType: "ImportBatch",
      entityId: batch.id,
      details: {
        sourceId: source.id,
        fileName: batch.fileName,
        totalRows: preview.totalRows,
        contentHash,
      },
    },
  });
  return {
    id: batch.id,
    status: batch.status,
    headers: preview.headers,
    previewRows: preview.rows.slice(0, 20).map(maskPersonalData),
    totalRows: preview.totalRows,
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    duplicateUpload: false,
  };
}

export async function previewMapping(input: {
  batchId: string;
  mapping: ColumnMapping;
}) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: input.batchId },
    include: { source: true },
  });
  if (!batch) throw new ImportInputError("Import batch was not found.");
  if (batch.status !== ImportStatus.PREVIEWED) {
    throw new ImportConflictError("Only a previewed import can preview a mapping.");
  }
  const extension = fileExtension(batch.fileName);
  const headers = batch.previewHeaders as string[];
  const mappingErrors = validateMapping(batch.source.kind, input.mapping, headers);
  if (mappingErrors.length > 0) throw new ImportInputError(mappingErrors.join(" "));

  const normalizedPreview: Array<{
    sourceRowNumber: number;
    raw: SourceRow;
    normalized: NormalizedRow;
  }> = [];
  await withImportFile(batch.storageKey, async (filePath) => {
    for await (const sourceRow of readSourceRows(filePath, extension)) {
      normalizedPreview.push({
        sourceRowNumber: sourceRow.rowNumber,
        raw: sourceRow.row,
        normalized: normalizedRow(batch.source.kind, sourceRow.row, input.mapping, sourceRow.rowNumber),
      });
      if (normalizedPreview.length >= 20) break;
    }
  });
  const mappingPreviewHash = hash(
    JSON.stringify({
      contentHash: batch.contentHash,
      mapping: input.mapping,
      normalized: normalizedPreview.map((row) => row.normalized),
    }),
  );
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { previewHash: mappingPreviewHash },
  });
  return {
    mappingPreviewHash,
    previewRows: normalizedPreview.map(({ sourceRowNumber, raw, normalized }) => ({
      sourceRowNumber,
      raw: maskPersonalData(raw),
      normalized: normalized.data,
      errors: normalized.errors,
    })),
  };
}

async function processChunk(input: {
  batchId: string;
  sourceId: string;
  partnerId: string;
  kind: ImportKind;
  rows: Array<{ rowNumber: number; raw: SourceRow }>;
  mapping: ColumnMapping;
  profile?: ImportProfile;
  skipExistingRows: boolean;
}) {
  const transactionStartedAt = performance.now();
  const normalizationStartedAt = performance.now();
  const parsedRows = input.rows.map((item) => ({
    ...item,
    normalized: normalizedRow(input.kind, item.raw, input.mapping, item.rowNumber),
  }));
  const profile: ImportChunkProfile = {
    rows: parsedRows.length,
    normalizationMs: performance.now() - normalizationStartedAt,
    duplicateDetectionMs: 0,
    existingRowsQueryMs: 0,
    serializationMs: 0,
    stageCopyMs: 0,
    orderInsertMs: 0,
    importRowsCopyMs: 0,
    transactionMs: 0,
  };
  const rowNumbers = parsedRows.map((row) => row.rowNumber);
  await prisma.$transaction(async (tx) => {
    let existingRows: Array<{ rowNumber: number }> = [];
    if (!input.skipExistingRows) {
      const existingRowsStartedAt = performance.now();
      existingRows = await tx.importRow.findMany({
        where: { batchId: input.batchId, rowNumber: { in: rowNumbers } },
        select: { rowNumber: true },
      });
      profile.existingRowsQueryMs = performance.now() - existingRowsStartedAt;
    }
    const existingNumbers = new Set(existingRows.map((row) => row.rowNumber));
    const pending = parsedRows.filter((row) => !existingNumbers.has(row.rowNumber));
    if (pending.length === 0) return;

    const valid = pending.filter((row) => row.normalized.errors.length === 0);
    const invalid = pending.filter((row) => row.normalized.errors.length > 0);

    const importRows: Prisma.ImportRowCreateManyInput[] = invalid.map((row) => ({
      id: randomUUID(),
      batchId: input.batchId,
      rowNumber: row.rowNumber,
      rawData: maskRawRow(row.raw),
      normalizedData: row.normalized.data as Prisma.InputJsonObject,
      status: ImportRowStatus.INVALID,
      validationErrors: row.normalized.errors as Prisma.InputJsonArray,
    }));

    const financialKinds: Record<ImportKind, FinancialRecordKind | null> = {
      ORDER: null,
      SETTLEMENT: FinancialRecordKind.SETTLEMENT,
      COD_REMITTANCE: FinancialRecordKind.COD_REMITTANCE,
      FREIGHT_INVOICE: FinancialRecordKind.FREIGHT_INVOICE,
      RETURN_RECEIPT: null,
      REFUND: FinancialRecordKind.REFUND,
    };
    const financialKind = financialKinds[input.kind];
    if (financialKind) {
      const validRows = valid;
      const seen = new Set<string>();
      const keys = validRows.map((row) => row.normalized.deduplicationKey ?? "");
      const existing = await tx.financialTransaction.findMany({
        where: { sourceId: input.sourceId, deduplicationKey: { in: keys } },
        select: { deduplicationKey: true },
      });
      const existingKeys = new Set(existing.map((record) => record.deduplicationKey));
      const accepted: typeof validRows = [];
      for (const row of validRows) {
        const key = row.normalized.deduplicationKey!;
        if (seen.has(key) || existingKeys.has(key)) {
          importRows.push({
            id: randomUUID(),
            batchId: input.batchId,
            rowNumber: row.rowNumber,
            rawData: maskRawRow(row.raw),
            normalizedData: row.normalized.data as Prisma.InputJsonObject,
            status: ImportRowStatus.DUPLICATE,
            validationErrors: ["Duplicate transaction reference."],
          });
        } else {
          seen.add(key);
          accepted.push(row);
        }
      }

      const orderLinks = accepted
        .map((row) => ({
          orderId: String(row.normalized.data.orderId ?? ""),
          rowId: String(row.rowNumber),
        }))
        .filter((row) => row.orderId);
      const orderIds = await tx.order.findMany({
        where: { externalId: { in: [...new Set(orderLinks.map((row) => row.orderId))] } },
        select: { id: true, externalId: true },
      });
      const ordersByExternalId = new Map<string, string[]>();
      for (const order of orderIds) {
        ordersByExternalId.set(order.externalId, [
          ...(ordersByExternalId.get(order.externalId) ?? []),
          order.id,
        ]);
      }
      const rowIdByNumber = new Map<number, string>();
      for (const row of accepted) {
        const orderId = String(row.normalized.data.orderId ?? "");
        const candidates = ordersByExternalId.get(orderId) ?? [];
        const resolvedOrderId = candidates.length === 1 ? candidates[0] : null;
        const importRowId = randomUUID();
        rowIdByNumber.set(row.rowNumber, importRowId);
        importRows.push({
          id: importRowId,
          batchId: input.batchId,
          rowNumber: row.rowNumber,
          rawData: maskRawRow(row.raw),
          normalizedData: row.normalized.data as Prisma.InputJsonObject,
          status: ImportRowStatus.PROCESSED,
          orderId: resolvedOrderId,
        });
      }
      await tx.importRow.createMany({ data: [...importRows, ...invalid.map((row) => ({
        id: randomUUID(),
        batchId: input.batchId,
        rowNumber: row.rowNumber,
        rawData: maskRawRow(row.raw),
        normalizedData: row.normalized.data as Prisma.InputJsonObject,
        status: ImportRowStatus.INVALID,
        validationErrors: row.normalized.errors as Prisma.InputJsonArray,
      }))], skipDuplicates: true });

      await tx.financialTransaction.createMany({
        data: accepted.map((row) => {
          const orderId = String(row.normalized.data.orderId ?? "");
          const candidates = ordersByExternalId.get(orderId) ?? [];
          return {
            sourceId: input.sourceId,
            partnerId: input.partnerId,
            importRowId: rowIdByNumber.get(row.rowNumber)!,
            orderId: candidates.length === 1 ? candidates[0] : null,
            kind: financialKind,
            externalReference: row.normalized.data.externalReference
              ? String(row.normalized.data.externalReference)
              : null,
            transactionDate: new Date(String(row.normalized.data.transactionDate)),
            currency: String(row.normalized.data.currency),
            grossAmount: new Prisma.Decimal(String(row.normalized.data.grossAmount ?? "0")),
            feeAmount: new Prisma.Decimal(String(row.normalized.data.feeAmount ?? "0")),
            tcsAmount: new Prisma.Decimal(String(row.normalized.data.tcsAmount ?? "0")),
            tdsAmount: new Prisma.Decimal(String(row.normalized.data.tdsAmount ?? "0")),
            netAmount: new Prisma.Decimal(String(row.normalized.data.netAmount ?? "0")),
            billedWeightKg: row.normalized.data.billedWeightKg
              ? new Prisma.Decimal(String(row.normalized.data.billedWeightKg))
              : null,
            deduplicationKey: row.normalized.deduplicationKey!,
          };
        }),
        skipDuplicates: true,
      });

      if (input.kind === ImportKind.REFUND) {
        const insertedTransactions = await tx.financialTransaction.findMany({
          where: {
            sourceId: input.sourceId,
            deduplicationKey: { in: accepted.map((row) => row.normalized.deduplicationKey!) },
            orderId: { not: null },
          },
          select: { id: true, orderId: true, netAmount: true, currency: true, importRowId: true },
        });
        const expectedByRow = new Map(
          accepted.map((row) => [rowIdByNumber.get(row.rowNumber)!, row.normalized.data.expectedAmount]),
        );
        await tx.refund.createMany({
          data: insertedTransactions.flatMap((transaction) => {
            const expected = expectedByRow.get(transaction.importRowId);
            if (!transaction.orderId || expected === null || expected === undefined) return [];
            return [{
              partnerId: input.partnerId,
              orderId: transaction.orderId,
              financialTransactionId: transaction.id,
              expectedAmount: new Prisma.Decimal(String(expected)),
              refundedAmount: transaction.netAmount.abs(),
              currency: transaction.currency,
              status:
                transaction.netAmount.abs().minus(new Prisma.Decimal(String(expected))).abs().lte(10)
                  ? RefundStatus.PROCESSED
                  : RefundStatus.MISMATCH,
            }];
          }),
          skipDuplicates: true,
        });
      }
      return;
    }

    const returnRows = valid;
    const orderIds = await tx.order.findMany({
      where: { externalId: { in: returnRows.map((row) => String(row.normalized.data.externalOrderId)) } },
      select: { id: true, externalId: true },
    });
    const ordersByExternalId = new Map<string, string[]>();
    for (const order of orderIds) {
      ordersByExternalId.set(order.externalId, [
        ...(ordersByExternalId.get(order.externalId) ?? []),
        order.id,
      ]);
    }
    const seenReturns = new Set<string>();
    const returnRecords: Prisma.ReturnReceiptCreateManyInput[] = [];
    for (const row of returnRows) {
      const key = row.normalized.deduplicationKey!;
      if (seenReturns.has(key)) {
        importRows.push({
          id: randomUUID(),
          batchId: input.batchId,
          rowNumber: row.rowNumber,
          rawData: maskRawRow(row.raw),
          normalizedData: row.normalized.data as Prisma.InputJsonObject,
          status: ImportRowStatus.DUPLICATE,
          validationErrors: ["Duplicate return receipt reference."],
        });
        continue;
      }
      seenReturns.add(key);
      const externalOrderId = String(row.normalized.data.externalOrderId);
      const candidates = ordersByExternalId.get(externalOrderId) ?? [];
      const orderId = candidates.length === 1 ? candidates[0] : null;
      const importRowId = randomUUID();
      importRows.push({
        id: importRowId,
        batchId: input.batchId,
        rowNumber: row.rowNumber,
        rawData: maskRawRow(row.raw),
        normalizedData: row.normalized.data as Prisma.InputJsonObject,
        status: ImportRowStatus.PROCESSED,
        orderId,
      });
      returnRecords.push({
        partnerId: input.partnerId,
        importRowId,
        orderId,
        externalOrderId,
        deduplicationKey: key.slice(0, 180),
        expectedReceiptAt: new Date(String(row.normalized.data.expectedReceiptAt)),
        receivedAt: row.normalized.data.receivedAt
          ? new Date(String(row.normalized.data.receivedAt))
          : null,
        warehouseReceiptReference: row.normalized.data.warehouseReceiptReference
          ? String(row.normalized.data.warehouseReceiptReference)
          : null,
        status:
          candidates.length !== 1
            ? ReturnStatus.REVIEW_REQUIRED
            : row.normalized.data.receivedAt
              ? ReturnStatus.RECEIVED
              : ReturnStatus.EXPECTED,
      });
    }
    importRows.push(...invalid.map((row) => ({
      id: randomUUID(),
      batchId: input.batchId,
      rowNumber: row.rowNumber,
      rawData: maskRawRow(row.raw),
      normalizedData: row.normalized.data as Prisma.InputJsonObject,
      status: ImportRowStatus.INVALID,
      validationErrors: row.normalized.errors as Prisma.InputJsonArray,
    })));
    await tx.importRow.createMany({ data: importRows, skipDuplicates: true });
    await tx.returnReceipt.createMany({ data: returnRecords, skipDuplicates: true });
  }, { timeout: 30_000 });
  profile.transactionMs = performance.now() - transactionStartedAt;
  input.profile?.chunks.push(profile);
}

export async function approveAndProcessImport(input: {
  batchId: string;
  mapping: ColumnMapping;
  mappingPreviewHash: string;
  mappingSuggestionId?: string;
  approvedById: string;
  profile?: ImportProfile;
}) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: input.batchId },
    include: { source: true },
  });
  if (!batch) throw new ImportInputError("Import batch was not found.");
  if (batch.status === ImportStatus.COMPLETED) {
    return {
      id: batch.id,
      status: batch.status,
      totalRows: batch.totalRows,
      acceptedRows: batch.acceptedRows,
      rejectedRows: batch.rejectedRows,
      duplicateRows: batch.duplicateRows,
      idempotentReplay: true,
    };
  }
  if (batch.status === ImportStatus.PROCESSING) {
    throw new ImportConflictError("This import is already processing.");
  }
  if (
    batch.status !== ImportStatus.PREVIEWED &&
    batch.status !== ImportStatus.FAILED
  ) {
    throw new ImportConflictError("This import is not ready for mapping approval.");
  }
  const headers = batch.previewHeaders as string[];
  const mappingErrors = validateMapping(batch.source.kind, input.mapping, headers);
  if (mappingErrors.length) throw new ImportInputError(mappingErrors.join(" "));
  if (input.mappingSuggestionId) {
    const suggestion = await prisma.mappingSuggestion.findFirst({
      where: {
        id: input.mappingSuggestionId,
        batchId: batch.id,
        sourceId: batch.sourceId,
        status: "PENDING",
      },
      select: { id: true },
    });
    if (!suggestion) {
      throw new MappingSuggestionInputError(
        "The AI mapping suggestion is no longer pending for this import.",
      );
    }
  }
  if (batch.previewHash !== input.mappingPreviewHash) {
    throw new ImportConflictError("Mapping preview is stale; preview and approve the current mapping.");
  }
  const normalizedPreview: Array<{
    row: number;
    raw: SourceRow;
    normalized: NormalizedRow;
  }> = [];
  await withImportFile(batch.storageKey, async (filePath) => {
    for await (const item of readSourceRows(filePath, fileExtension(batch.fileName))) {
      normalizedPreview.push({
        row: item.rowNumber,
        raw: item.row,
        normalized: normalizedRow(batch.source.kind, item.row, input.mapping, item.rowNumber),
      });
      if (normalizedPreview.length === 20) break;
    }
  });
  const expectedPreviewHash = hash(
    JSON.stringify({
      contentHash: batch.contentHash,
      mapping: input.mapping,
      normalized: normalizedPreview.map((row) => row.normalized),
    }),
  );
  if (expectedPreviewHash !== input.mappingPreviewHash) {
    throw new ImportConflictError("The approved mapping differs from the previewed mapping.");
  }

  const claimed = await prisma.importBatch.updateMany({
    where: { id: batch.id, status: batch.status },
    data: { status: ImportStatus.PROCESSING },
  });
  if (claimed.count !== 1) {
    throw new ImportConflictError("This import was claimed by another processing request.");
  }

  let orderCopyWriter: OrderCopyWriter | undefined;
  try {
    let mappingVersionId = batch.mappingVersionId;
    if (!mappingVersionId) {
      const version = await prisma.$transaction(async (tx) => {
      const latest = await tx.mappingVersion.findFirst({
        where: { sourceId: batch.sourceId },
        orderBy: { version: "desc" },
      });
      const created = await tx.mappingVersion.create({
        data: {
          sourceId: batch.sourceId,
          version: (latest?.version ?? 0) + 1,
          mapping: input.mapping as Prisma.InputJsonObject,
          previewRows: normalizedPreview.map(({ row, raw, normalized }) => ({
            sourceRowNumber: row,
            raw: maskRawRow(raw),
            normalized: normalized.data,
            errors: normalized.errors,
          })) as Prisma.InputJsonArray,
          approvedById: input.approvedById,
        },
      });
      await tx.importSource.update({
        where: { id: batch.sourceId },
        data: { activeMappingVersionId: created.id },
      });
      await tx.importBatch.update({
        where: { id: batch.id },
        data: { mappingVersionId: created.id },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.approvedById,
          action: "COLUMN_MAPPING_APPROVED",
          entityType: "MappingVersion",
          entityId: created.id,
          details: { sourceId: batch.sourceId, version: created.version },
        },
      });
      return created;
      });
      mappingVersionId = version.id;
    }
    if (input.mappingSuggestionId) {
      await recordMappingSuggestionDecision({
        suggestionId: input.mappingSuggestionId,
        batchId: batch.id,
        sourceId: batch.sourceId,
        mapping: input.mapping,
        actorId: input.approvedById,
      });
    }

    if (batch.source.kind === ImportKind.ORDER) {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required for bulk order ingestion.");
      }
      orderCopyWriter = await OrderCopyWriter.connect(process.env.DATABASE_URL);
    }

    const processRows = async (rows: Array<{ rowNumber: number; raw: SourceRow }>) => {
      if (orderCopyWriter) {
        const normalizationStartedAt = performance.now();
        const parsedRows = rows.map((row) => ({
          ...row,
          normalized: normalizedRow(ImportKind.ORDER, row.raw, input.mapping, row.rowNumber),
        }));
        const normalizationMs = performance.now() - normalizationStartedAt;
        const metrics = await orderCopyWriter.processChunk({
          batchId: batch.id,
          partnerId: batch.source.partnerId,
          rows: parsedRows,
          skipExistingRows: batch.status === ImportStatus.PREVIEWED,
        });
        input.profile?.chunks.push({ ...metrics, normalizationMs });
        return;
      }
      await processChunk({
        batchId: batch.id,
        sourceId: batch.sourceId,
        partnerId: batch.source.partnerId,
        kind: batch.source.kind,
        rows,
        mapping: input.mapping,
        profile: input.profile,
        skipExistingRows: batch.status === ImportStatus.PREVIEWED,
      });
    };

    await withImportFile(batch.storageKey, async (filePath) => {
      const chunk: Array<{ rowNumber: number; raw: SourceRow }> = [];
      let readStartedAt = performance.now();
      for await (const item of readSourceRows(filePath, fileExtension(batch.fileName))) {
        chunk.push({ rowNumber: item.rowNumber, raw: item.row });
        if (chunk.length >= CHUNK_SIZE) {
          if (input.profile) {
            input.profile.csvReadMs += performance.now() - readStartedAt;
          }
          await processRows([...chunk]);
          chunk.length = 0;
          readStartedAt = performance.now();
        }
      }
      if (input.profile) {
        input.profile.csvReadMs += performance.now() - readStartedAt;
      }
      if (chunk.length > 0) {
        await processRows(chunk);
      }
    });
    const grouped = await prisma.importRow.groupBy({
      by: ["status"],
      where: { batchId: batch.id },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((item) => [item.status, item._count._all]));
    const acceptedRows = counts.get(ImportRowStatus.PROCESSED) ?? 0;
    const rejectedRows = counts.get(ImportRowStatus.INVALID) ?? 0;
    const duplicateRows = counts.get(ImportRowStatus.DUPLICATE) ?? 0;
    const processedRows = acceptedRows + rejectedRows + duplicateRows;
    const updated = await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: ImportStatus.COMPLETED,
        totalRows: processedRows,
        processedRows,
        acceptedRows,
        rejectedRows,
        duplicateRows,
        completedAt: new Date(),
        errorSummary: rejectedRows
          ? { invalidRows: rejectedRows }
          : Prisma.DbNull,
      },
      select: {
        id: true,
        status: true,
        totalRows: true,
        acceptedRows: true,
        rejectedRows: true,
        duplicateRows: true,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: input.approvedById,
        action: "IMPORT_PROCESSED",
        entityType: "ImportBatch",
        entityId: batch.id,
        details: { acceptedRows, rejectedRows, duplicateRows },
      },
    });
    return { ...updated, idempotentReplay: false };
  } catch (error) {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: ImportStatus.FAILED,
        errorSummary: {
          message: error instanceof Error ? error.message : "Unexpected import failure.",
        },
      },
    });
    throw error;
  } finally {
    await orderCopyWriter?.close();
  }
}

export async function rollbackMapping(input: {
  sourceId: string;
  version: number;
  actorId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const source = await tx.importSource.findUnique({
      where: { id: input.sourceId },
      include: { activeMappingVersion: true },
    });
    const target = await tx.mappingVersion.findUnique({
      where: {
        sourceId_version: { sourceId: input.sourceId, version: input.version },
      },
    });
    if (!source || !target) throw new ImportInputError("Import source or mapping version was not found.");
    const latest = await tx.mappingVersion.findFirst({
      where: { sourceId: source.id },
      orderBy: { version: "desc" },
    });
    const rollback = await tx.mappingVersion.create({
      data: {
        sourceId: source.id,
        version: (latest?.version ?? 0) + 1,
        mapping: target.mapping as Prisma.InputJsonObject,
        previewRows: target.previewRows as Prisma.InputJsonArray,
        rollbackOfId: target.id,
        approvedById: input.actorId,
      },
    });
    await tx.importSource.update({
      where: { id: source.id },
      data: { activeMappingVersionId: rollback.id },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "COLUMN_MAPPING_ROLLED_BACK",
        entityType: "MappingVersion",
        entityId: rollback.id,
        details: { sourceId: source.id, rolledBackToVersion: target.version },
      },
    });
    return rollback;
  });
}
