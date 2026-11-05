import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";

type ExplainResult = {
  "QUERY PLAN": Array<Record<string, unknown>>;
};

const rollback = new Error("Rollback profiling inserts.");

async function main() {
  await prisma.$connect();
  const partner = await prisma.partner.findUniqueOrThrow({
    where: { code: "website" },
    select: { id: true },
  });
  const batch = await prisma.importBatch.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const tableStats = await prisma.$queryRaw<Array<{
    relname: string;
    liveRows: bigint;
    deadRows: bigint;
    totalBytes: bigint;
    indexBytes: bigint;
  }>>`
    SELECT
      tables.relname,
      stats.n_live_tup AS "liveRows",
      stats.n_dead_tup AS "deadRows",
      pg_total_relation_size(tables.oid) AS "totalBytes",
      pg_indexes_size(tables.oid) AS "indexBytes"
    FROM pg_class AS tables
    JOIN pg_stat_user_tables AS stats ON stats.relid = tables.oid
    WHERE tables.relname IN ('orders', 'import_rows')
    ORDER BY tables.relname
  `;
  const settings = await prisma.$queryRaw<Array<{
    synchronousCommit: string;
    walSyncMethod: string;
    sharedBuffers: string;
    effectiveCacheSize: string;
  }>>`
    SELECT
      current_setting('synchronous_commit') AS "synchronousCommit",
      current_setting('wal_sync_method') AS "walSyncMethod",
      current_setting('shared_buffers') AS "sharedBuffers",
      current_setting('effective_cache_size') AS "effectiveCacheSize"
  `;
  const orderPrefix = `PERF-EXPLAIN-${randomUUID()}`;
  let orderPlan: ExplainResult[] = [];
  let importRowPlan: ExplainResult[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      orderPlan = await tx.$queryRaw<ExplainResult[]>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        INSERT INTO orders (
          id, channel_partner_id, external_id, order_date, payment_method,
          delivery_status, order_value, currency, created_at, updated_at
        )
        SELECT gen_random_uuid(), ${partner.id}::uuid,
          ${orderPrefix} || '-' || series::text, now(), 'PREPAID', 'DELIVERED',
          1000.00, 'INR', now(), now()
        FROM generate_series(1, 2000) AS series
      `;
      const maxRow = await tx.importRow.aggregate({
        where: { batchId: batch.id },
        _max: { rowNumber: true },
      });
      importRowPlan = await tx.$queryRaw<ExplainResult[]>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        INSERT INTO import_rows (
          id, batch_id, row_number, raw_data, normalized_data, status, created_at
        )
        SELECT gen_random_uuid(), ${batch.id}::uuid, ${maxRow._max.rowNumber ?? 0} + series,
          '{"synthetic":true}'::jsonb, '{"orderValue":"1000.00"}'::jsonb,
          'INVALID', now()
        FROM generate_series(1, 2000) AS series
      `;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await prisma.$disconnect();
  }

  const summarize = (explain: ExplainResult[]) => {
    const root = explain[0]["QUERY PLAN"][0];
    return {
      nodeType: root["Plan"] && (root["Plan"] as Record<string, unknown>)["Node Type"],
      actualRows: root["Plan"] && (root["Plan"] as Record<string, unknown>)["Actual Rows"],
      executionTimeMs: root["Execution Time"],
      planningTimeMs: root["Planning Time"],
      sharedHitBlocks: root["Plan"] && (root["Plan"] as Record<string, unknown>)["Shared Hit Blocks"],
      sharedReadBlocks: root["Plan"] && (root["Plan"] as Record<string, unknown>)["Shared Read Blocks"],
    };
  };
  console.log(JSON.stringify({
    note: "EXPLAIN ANALYZE executed 2,000 synthetic inserts per table inside a transaction that was rolled back.",
    tableStats: tableStats.map((table) => ({
      ...table,
      liveRows: String(table.liveRows),
      deadRows: String(table.deadRows),
      totalBytes: String(table.totalBytes),
      indexBytes: String(table.indexBytes),
    })),
    settings: settings[0],
    orders: summarize(orderPlan),
    importRows: summarize(importRowPlan),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
