import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ImportKind } from "@prisma/client";
import {
  approveAndProcessImport,
  type ImportProfile,
  previewMapping,
  uploadImportPreview,
} from "../src/lib/imports/service";
import { prisma } from "../src/lib/db";
import { runReconciliation } from "../src/lib/reconciliation/service";
import { Prisma } from "@prisma/client";

const ROW_COUNT = 100_000;

async function writeSyntheticCsv(filePath: string, prefix: string) {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  const write = async (value: string) => {
    if (!stream.write(value)) await once(stream, "drain");
  };
  await write(
    "Order ID,Order Date,Order Value,Payment Method,Delivery Status,Currency\r\n",
  );
  for (let first = 0; first < ROW_COUNT; first += 1_000) {
    let chunk = "";
    const last = Math.min(first + 1_000, ROW_COUNT);
    for (let index = first; index < last; index += 1) {
      chunk += `${prefix}-${index},2026-10-01,1000.00,PREPAID,DELIVERED,INR\r\n`;
    }
    await write(chunk);
  }
  stream.end();
  await once(stream, "finish");
}

async function runTrial(label: string) {
  await prisma.$connect();

  const benchmarkId = randomUUID();
  const prefix = `BENCH-${benchmarkId}`;
  const sourceKey = `benchmark-${benchmarkId}`;
  const fileName = `benchmark-${benchmarkId}.csv`;
  const generatedFile = path.join(process.cwd(), ".data", "benchmarks", fileName);
  const mapping = {
    externalId: "Order ID",
    orderDate: "Order Date",
    orderValue: "Order Value",
    paymentMethod: "Payment Method",
    deliveryStatus: "Delivery Status",
    currency: "Currency",
  };
  let batchId: string | undefined;
  let runId: string | undefined;
  let storageKey: string | undefined;
  const benchmarkStartedAt = performance.now();
  const importProfile: ImportProfile = { csvReadMs: 0, chunks: [] };

  try {
    await mkdir(path.dirname(generatedFile), { recursive: true });
    await writeSyntheticCsv(generatedFile, prefix);
    const file = await readFile(generatedFile);
    const actor = await prisma.user.findFirstOrThrow({
      where: { role: "FINANCE_EXECUTIVE", isActive: true },
      select: { id: true },
    });

    const importStartedAt = performance.now();
    const uploaded = await uploadImportPreview({
      partnerCode: "website",
      kind: ImportKind.ORDER,
      sourceKey,
      fileName,
      file,
      uploadedById: actor.id,
    });
    batchId = uploaded.id;
    const uploadPreviewMs = Math.round(performance.now() - importStartedAt);
    const mappingPreviewStartedAt = performance.now();
    const preview = await previewMapping({ batchId, mapping });
    const mappingPreviewMs = Math.round(performance.now() - mappingPreviewStartedAt);
    const processingStartedAt = performance.now();
    const imported = await approveAndProcessImport({
      batchId,
      mapping,
      mappingPreviewHash: preview.mappingPreviewHash,
      approvedById: actor.id,
      profile: importProfile,
    });
    const processingMs = Math.round(performance.now() - processingStartedAt);
    const importMs = Math.round(performance.now() - importStartedAt);
    if (imported.acceptedRows !== ROW_COUNT || imported.rejectedRows !== 0) {
      throw new Error(
        `Import benchmark data did not validate: accepted=${imported.acceptedRows}, rejected=${imported.rejectedRows}.`,
      );
    }

    const retry = await approveAndProcessImport({
      batchId,
      mapping,
      mappingPreviewHash: preview.mappingPreviewHash,
      approvedById: actor.id,
    });
    if (!retry.idempotentReplay) {
      throw new Error("Import replay did not report idempotent completion.");
    }

    const batchCounts = await prisma.importRow.groupBy({
      by: ["status"],
      where: { batchId },
      _count: { _all: true },
    });
    const countByStatus = new Map(batchCounts.map((item) => [item.status, item._count._all]));
    const orderTotals = await prisma.order.aggregate({
      where: { importRows: { some: { batchId } } },
      _count: { _all: true },
      _sum: { orderValue: true },
    });
    if (
      (countByStatus.get("PROCESSED") ?? 0) !== ROW_COUNT ||
      (countByStatus.get("INVALID") ?? 0) !== 0 ||
      (countByStatus.get("DUPLICATE") ?? 0) !== 0 ||
      orderTotals._count._all !== ROW_COUNT ||
      !orderTotals._sum.orderValue?.eq(new Prisma.Decimal(ROW_COUNT).mul(1_000))
    ) {
      throw new Error("Imported row counts or Decimal total failed integrity verification.");
    }

    const planRows = await prisma.$queryRaw<Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT row_number
      FROM import_rows
      WHERE batch_id = ${batchId}::uuid AND row_number BETWEEN 2 AND 2001
    `;
    const plan = planRows[0]["QUERY PLAN"][0];
    const pgStat = await prisma.$queryRaw<Array<{ installed: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      ) AS installed
    `;
    let pgStatStatements: { available: boolean; details?: unknown; reason?: string } = {
      available: false,
      reason: "pg_stat_statements extension is not installed.",
    };
    if (pgStat[0].installed) {
      try {
        const stats = await prisma.$queryRaw<Array<{
          calls: bigint;
          total_exec_time: number;
          rows: bigint;
        }>>`
          SELECT calls, total_exec_time, rows
          FROM pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY total_exec_time DESC
          LIMIT 10
        `;
        pgStatStatements = { available: true, details: stats };
      } catch (error) {
        pgStatStatements = {
          available: false,
          reason: error instanceof Error ? error.message : "Could not read pg_stat_statements.",
        };
      }
    }

    const reconciliationStartedAt = performance.now();
    const reconciliation = await runReconciliation({
      batchIds: [batchId],
      initiatedById: actor.id,
    });
    runId = reconciliation.runId;
    const reconciliationMs = Math.round(performance.now() - reconciliationStartedAt);
    const reconciliationReplay = await runReconciliation({
      batchIds: [batchId],
      initiatedById: actor.id,
    });
    if (!reconciliationReplay.idempotentReplay) {
      throw new Error("Completed reconciliation did not replay idempotently.");
    }
    const statusCounts = await prisma.reconciliationResult.groupBy({
      by: ["status"],
      where: { runId },
      _count: { _all: true },
    });
    const settledAndReviewableCount = statusCounts.reduce((sum, item) => sum + item._count._all, 0);
    const totalExpected = await prisma.reconciliationResult.aggregate({
      where: { runId },
      _sum: { expectedAmount: true, receivedAmount: true },
    });
    if (settledAndReviewableCount !== ROW_COUNT) {
      throw new Error("Reconciliation results do not match the imported order count.");
    }
    const [dbInfo, resultCount, rowCount] = await Promise.all([
      prisma.$queryRaw<Array<{ version: string; database: string; port: number }>>`
        SELECT version() AS version, current_database() AS database, inet_server_port() AS port
      `,
      prisma.reconciliationResult.count({ where: { runId } }),
      prisma.importRow.count({ where: { batchId } }),
    ]);

    const report = {
      label,
      rows: ROW_COUNT,
      imported: imported.acceptedRows,
      rejected: imported.rejectedRows,
      duplicates: imported.duplicateRows,
      stagedImportRows: rowCount,
      reconciliationResults: resultCount,
      importRowStatusCounts: Object.fromEntries(countByStatus),
      orderCount: orderTotals._count._all,
      orderValueTotal: orderTotals._sum.orderValue?.toFixed(2),
      reconciliationStatusCounts: Object.fromEntries(
        statusCounts.map((item) => [item.status, item._count._all]),
      ),
      importIdempotencyVerified: retry.idempotentReplay,
      reconciliationIdempotencyVerified: reconciliationReplay.idempotentReplay,
      reconciliationExpectedAmountTotal: totalExpected._sum.expectedAmount?.toFixed(2),
      reconciliationReceivedAmountTotal: totalExpected._sum.receivedAmount?.toFixed(2),
      uploadPreviewMs,
      mappingPreviewMs,
      processingMs,
      csvReadMs: Math.round(importProfile.csvReadMs),
      chunkPhaseTotalsMs: {
        normalization: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.normalizationMs, 0)),
        duplicateDetection: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.duplicateDetectionMs, 0)),
        existingRowsQuery: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.existingRowsQueryMs, 0)),
        serialization: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.serializationMs, 0)),
        stageCopy: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.stageCopyMs, 0)),
        orderInsert: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.orderInsertMs, 0)),
        importRowsCopy: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.importRowsCopyMs, 0)),
        transactions: Math.round(importProfile.chunks.reduce((sum, item) => sum + item.transactionMs, 0)),
      },
      importRowsExplainAnalyze: {
        nodeType: plan["Plan"] && (plan["Plan"] as Record<string, unknown>)["Node Type"],
        executionTimeMs: plan["Execution Time"],
        sharedHitBlocks: plan["Planning"] && (plan["Planning"] as Record<string, unknown>)["Shared Hit Blocks"],
      },
      pgStatStatements,
      importMs,
      reconciliationMs,
      endToEndMs: Math.round(performance.now() - benchmarkStartedAt),
      underSixtySeconds: importMs < 60_000,
      node: process.version,
      platform: `${process.platform} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: os.totalmem(),
      database: dbInfo[0],
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    const partner = await prisma.partner.findUnique({
      where: { code: "website" },
      select: { id: true },
    });
    const source = partner
      ? await prisma.importSource.findUnique({
          where: {
            partnerId_kind_sourceKey: {
              partnerId: partner.id,
              kind: ImportKind.ORDER,
              sourceKey,
            },
          },
          include: { mappingVersions: true, batches: true },
        })
      : null;
    if (source) {
      const batchIds = source.batches.map((batch) => batch.id);
      storageKey = source.batches.find((batch) => batch.id === batchId)?.storageKey;
      const runIds = runId ? [runId] : [];
      await prisma.$transaction(async (tx) => {
        await tx.auditLog.deleteMany({
          where: {
            OR: [
              { entityType: "ImportBatch", entityId: { in: batchIds } },
              {
                entityType: "MappingVersion",
                entityId: { in: source.mappingVersions.map((item) => item.id) },
              },
              { entityType: "ReconciliationRun", entityId: { in: runIds } },
            ],
          },
        });
        if (runIds.length > 0) {
          await tx.reconciliationTransaction.deleteMany({ where: { result: { runId: { in: runIds } } } });
          await tx.reconciliationException.deleteMany({ where: { result: { runId: { in: runIds } } } });
          await tx.reconciliationResult.deleteMany({ where: { runId: { in: runIds } } });
          await tx.reconciliationRun.deleteMany({ where: { id: { in: runIds } } });
        }
        await tx.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
        if (partner) {
          await tx.order.deleteMany({
            where: {
              channelPartnerId: partner.id,
              externalId: { startsWith: `${prefix}-` },
            },
          });
        }
        await tx.importBatch.deleteMany({ where: { id: { in: batchIds } } });
        await tx.importSource.update({
          where: { id: source.id },
          data: { activeMappingVersionId: null },
        });
        await tx.mappingVersion.deleteMany({ where: { sourceId: source.id } });
        await tx.importSource.delete({ where: { id: source.id } });
      }, { timeout: 120_000 });
    }
    if (storageKey) {
      await rm(path.join(process.cwd(), ".data", "imports", storageKey), { force: true });
    }
    await rm(generatedFile, { force: true });
    await prisma.$disconnect();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured to run the database benchmark.");
  }
  const warmup = await runTrial("warmup");
  const trials = [];
  for (let index = 1; index <= 3; index += 1) {
    trials.push(await runTrial(`measured-${index}`));
  }
  const median = (values: number[]) =>
    [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
  const summary = {
    warmup: {
      label: warmup.label,
      importMs: warmup.importMs,
      reconciliationMs: warmup.reconciliationMs,
    },
    measuredTrials: trials.map((trial) => ({
      label: trial.label,
      importMs: trial.importMs,
      reconciliationMs: trial.reconciliationMs,
      imported: trial.imported,
      rejected: trial.rejected,
      duplicates: trial.duplicates,
      orderValueTotal: trial.orderValueTotal,
      reconciliationResults: trial.reconciliationResults,
      importIdempotencyVerified: trial.importIdempotencyVerified,
      reconciliationIdempotencyVerified: trial.reconciliationIdempotencyVerified,
    })),
    medianImportMs: median(trials.map((trial) => trial.importMs)),
    medianReconciliationMs: median(trials.map((trial) => trial.reconciliationMs)),
    importTargetMetInEveryMeasuredTrial: trials.every((trial) => trial.importMs < 60_000),
  };
  console.log(JSON.stringify({ benchmarkSummary: summary }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
