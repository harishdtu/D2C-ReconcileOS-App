import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ExceptionStatus,
  ImportKind,
  Prisma,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveAndProcessImport,
  previewMapping,
  uploadImportPreview,
} from "../src/lib/imports/service";
import { prisma } from "../src/lib/db";
import { transitionException } from "../src/lib/exceptions/service";
import {
  ReconciliationConflictError,
  runReconciliation,
} from "../src/lib/reconciliation/service";

describe("import and reconciliation workflows", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be configured for workflow integration tests.");
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("imports, validates, deduplicates, retries idempotently, reconciles concurrently, and audits exception resolution", async () => {
    const suffix = randomUUID();
    const orderId = `M3-TEST-${suffix}`;
    const file = Buffer.from(
      [
        "Order ID,Order Date,Order Value,Payment Method,Delivery Status,Customer Phone",
        `${orderId},2026-10-01,1000.00,PREPAID,DELIVERED,9876543210`,
        `${orderId},2026-10-01,1000.00,PREPAID,DELIVERED,9876543210`,
        `INVALID-${suffix},2026-10-01,not-money,PREPAID,DELIVERED,9876543210`,
        "ORD-W-204118,2026-10-01,1000.00,PREPAID,DELIVERED,9876543210",
      ].join("\r\n"),
    );
    const sourceKey = `milestone-3-test-${suffix}`;
    const contentHash = createHash("sha256").update(file).digest("hex");
    const user = await prisma.user.findFirstOrThrow({
      where: { role: "FINANCE_EXECUTIVE", isActive: true },
      select: { id: true },
    });
    const mapping = {
      externalId: "Order ID",
      orderDate: "Order Date",
      orderValue: "Order Value",
      paymentMethod: "Payment Method",
      deliveryStatus: "Delivery Status",
    };
    let batchId: string | undefined;
    let runId: string | undefined;
    let exceptionId: string | undefined;

    try {
      const uploaded = await uploadImportPreview({
        partnerCode: "website",
        kind: ImportKind.ORDER,
        sourceKey,
        fileName: "milestone-3-test.csv",
        file,
        uploadedById: user.id,
      });
      batchId = uploaded.id;
      expect(uploaded.totalRows).toBe(4);
      expect(uploaded.previewRows?.[0]?.["Customer Phone"]).toBe("[REDACTED]");

      const preview = await previewMapping({ batchId, mapping });
      expect(preview.previewRows).toHaveLength(4);
      expect(preview.previewRows[2].errors).toContain(
        "Order value must be a decimal amount with at most two fractional digits.",
      );

      const imported = await approveAndProcessImport({
        batchId,
        mapping,
        mappingPreviewHash: preview.mappingPreviewHash,
        approvedById: user.id,
      });
      expect(imported).toMatchObject({
        status: "COMPLETED",
        totalRows: 4,
        acceptedRows: 1,
        rejectedRows: 1,
        duplicateRows: 2,
        idempotentReplay: false,
      });
      const savedImportRow = await prisma.importRow.findFirstOrThrow({
        where: { batchId, status: "PROCESSED" },
      });
      expect(savedImportRow.rawData).toMatchObject({
        "Customer Phone": "[REDACTED]",
      });
      const replayed = await approveAndProcessImport({
        batchId,
        mapping,
        mappingPreviewHash: preview.mappingPreviewHash,
        approvedById: user.id,
      });
      expect(replayed.idempotentReplay).toBe(true);

      const duplicateUpload = await uploadImportPreview({
        partnerCode: "website",
        kind: ImportKind.ORDER,
        sourceKey,
        fileName: "milestone-3-test.csv",
        file,
        uploadedById: user.id,
      });
      expect(duplicateUpload.duplicateUpload).toBe(true);
      expect(duplicateUpload.id).toBe(batchId);

      const order = await prisma.order.findUniqueOrThrow({
        where: {
          channelPartnerId_externalId: {
            channelPartnerId: (
              await prisma.partner.findUniqueOrThrow({
                where: { code: "website" },
                select: { id: true },
              })
            ).id,
            externalId: orderId,
          },
        },
      });
      expect(order.orderValue.toFixed(2)).toBe("1000.00");
      const results = await Promise.allSettled([
        runReconciliation({ batchIds: [batchId], initiatedById: user.id }),
        runReconciliation({ batchIds: [batchId], initiatedById: user.id }),
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runReconciliation>>> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled.length).toBeGreaterThan(0);
      for (const result of rejected) {
        expect(result.reason).toBeInstanceOf(ReconciliationConflictError);
      }
      const reconciliation = fulfilled[0].value;
      runId = reconciliation.runId;
      const reconciliationResult = await prisma.reconciliationResult.findUniqueOrThrow({
        where: { runId_orderId: { runId, orderId: order.id } },
      });
      expect(reconciliationResult.status).toBe("REVIEW_REQUIRED");

      const partner = await prisma.partner.findUniqueOrThrow({
        where: { code: "website" },
        select: { id: true },
      });
      const exception = await prisma.reconciliationException.create({
        data: {
          resultId: reconciliationResult.id,
          partnerId: partner.id,
          kind: "SHORT_PAYMENT",
          status: ExceptionStatus.OPEN,
          amountAtRisk: new Prisma.Decimal("25.10"),
          currency: "INR",
          evidenceSnapshot: { source: "integration-test" },
        },
      });
      exceptionId = exception.id;
      await transitionException({
        exceptionId,
        actorId: user.id,
        status: ExceptionStatus.IN_REVIEW,
        resolutionNote: "Finance review started.",
      });
      const resolved = await transitionException({
        exceptionId,
        actorId: user.id,
        status: ExceptionStatus.RESOLVED,
        resolutionNote: "Verified against the partner statement.",
      });
      expect(resolved.status).toBe(ExceptionStatus.RESOLVED);
      expect(resolved.resolutionNote).toBe("Verified against the partner statement.");
      expect(
        await prisma.auditLog.count({
          where: { entityType: "ReconciliationException", entityId: exceptionId },
        }),
      ).toBe(2);
    } finally {
      const source = await prisma.importSource.findUnique({
        where: {
          partnerId_kind_sourceKey: {
            partnerId: (
              await prisma.partner.findUniqueOrThrow({
                where: { code: "website" },
                select: { id: true },
              })
            ).id,
            kind: ImportKind.ORDER,
            sourceKey,
          },
        },
        include: { batches: true, mappingVersions: true },
      });
      await prisma.$transaction(async (tx) => {
        if (exceptionId) {
          await tx.auditLog.deleteMany({
            where: { entityType: "ReconciliationException", entityId: exceptionId },
          });
          await tx.reconciliationException.deleteMany({ where: { id: exceptionId } });
        }
        if (runId) {
          await tx.auditLog.deleteMany({
            where: { entityType: "ReconciliationRun", entityId: runId },
          });
          await tx.reconciliationTransaction.deleteMany({ where: { result: { runId } } });
          await tx.reconciliationException.deleteMany({ where: { result: { runId } } });
          await tx.reconciliationResult.deleteMany({ where: { runId } });
          await tx.reconciliationRun.deleteMany({ where: { id: runId } });
        }
        if (source) {
          const batchIds = source.batches.map((batch) => batch.id);
          await tx.auditLog.deleteMany({
            where: { entityType: "ImportBatch", entityId: { in: batchIds } },
          });
          await tx.auditLog.deleteMany({
            where: {
              entityType: "MappingVersion",
              entityId: { in: source.mappingVersions.map((mappingVersion) => mappingVersion.id) },
            },
          });
          await tx.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
          await tx.order.deleteMany({ where: { externalId: orderId } });
          await tx.importBatch.deleteMany({ where: { id: { in: batchIds } } });
          await tx.importSource.update({
            where: { id: source.id },
            data: { activeMappingVersionId: null },
          });
          await tx.mappingVersion.deleteMany({ where: { sourceId: source.id } });
          await tx.importSource.delete({ where: { id: source.id } });
        }
      });
      await rm(path.join(process.cwd(), ".data", "imports", `${contentHash}.csv`), {
        force: true,
      });
    }
  });
});
