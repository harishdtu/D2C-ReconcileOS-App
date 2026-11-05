import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Pool, type PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { maskPersonalData } from "./files";

type NormalizedOrderRow = {
  rowNumber: number;
  raw: Record<string, string>;
  normalized: {
    data: Record<string, string | number | boolean | null>;
    errors: string[];
  };
};

export type OrderCopyChunkMetrics = {
  rows: number;
  duplicateDetectionMs: number;
  existingRowsQueryMs: number;
  serializationMs: number;
  stageCopyMs: number;
  orderInsertMs: number;
  importRowsCopyMs: number;
  transactionMs: number;
};

function csvField(value: string | null): string {
  if (value === null) return "\\N";
  return `"${value.replaceAll('"', '""')}"`;
}

function jsonField(value: unknown): string {
  return JSON.stringify(value);
}

export class OrderCopyWriter {
  private readonly pool: Pool;
  private readonly client: PoolClient;
  private closed = false;

  private constructor(pool: Pool, client: PoolClient) {
    this.pool = pool;
    this.client = client;
  }

  static async connect(connectionString: string): Promise<OrderCopyWriter> {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const client = await pool.connect();
      await client.query(`
        CREATE TEMP TABLE reconcileos_order_import_stage (
          row_number integer NOT NULL,
          raw_data jsonb NOT NULL,
          normalized_data jsonb NOT NULL,
          validation_errors jsonb NOT NULL,
          duplicate_in_file boolean NOT NULL,
          external_id text,
          order_date text,
          delivered_at text,
          settlement_due_at text,
          payment_method text,
          delivery_status text,
          order_value text,
          currency text
        ) ON COMMIT DELETE ROWS
      `);
      return new OrderCopyWriter(pool, client);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async processChunk(input: {
    batchId: string;
    partnerId: string;
    rows: NormalizedOrderRow[];
    skipExistingRows: boolean;
  }): Promise<OrderCopyChunkMetrics> {
    if (this.closed) throw new Error("Order COPY writer is closed.");
    const metrics: OrderCopyChunkMetrics = {
      rows: input.rows.length,
      duplicateDetectionMs: 0,
      existingRowsQueryMs: 0,
      serializationMs: 0,
      stageCopyMs: 0,
      orderInsertMs: 0,
      importRowsCopyMs: 0,
      transactionMs: 0,
    };
    const transactionStartedAt = performance.now();
    await this.client.query("BEGIN");
    try {
      let existingRows = new Set<number>();
      if (!input.skipExistingRows) {
        const queryStartedAt = performance.now();
        const result = await this.client.query<{ row_number: number }>(
          `SELECT row_number FROM import_rows WHERE batch_id = $1::uuid AND row_number = ANY($2::integer[])`,
          [input.batchId, input.rows.map((row) => row.rowNumber)],
        );
        existingRows = new Set(result.rows.map((row) => row.row_number));
        metrics.existingRowsQueryMs = performance.now() - queryStartedAt;
      }

      const pending = input.rows.filter((row) => !existingRows.has(row.rowNumber));
      if (pending.length === 0) {
        await this.client.query("COMMIT");
        metrics.transactionMs = performance.now() - transactionStartedAt;
        return metrics;
      }

      const duplicateDetectionStartedAt = performance.now();
      const seenOrderIds = new Set<string>();
      const duplicateInFile = new Set<number>();
      for (const row of pending) {
        if (row.normalized.errors.length > 0) continue;
        const externalId = String(row.normalized.data.externalId);
        if (seenOrderIds.has(externalId)) duplicateInFile.add(row.rowNumber);
        else seenOrderIds.add(externalId);
      }
      metrics.duplicateDetectionMs = performance.now() - duplicateDetectionStartedAt;

      let rowSerializationMs = 0;
      async function* stageCopyRows() {
        let chunk = "";
        let bufferedRows = 0;
        for (const row of pending) {
          const rowStartedAt = performance.now();
          const normalized = row.normalized.data;
          const fields = [
            String(row.rowNumber),
            jsonField(maskPersonalData(row.raw)),
            jsonField(normalized),
            jsonField(row.normalized.errors),
            duplicateInFile.has(row.rowNumber) ? "true" : "false",
            normalized.externalId === null ? null : String(normalized.externalId),
            normalized.orderDate === null ? null : String(normalized.orderDate),
            normalized.deliveredAt === null ? null : String(normalized.deliveredAt),
            normalized.settlementDueAt === null ? null : String(normalized.settlementDueAt),
            normalized.paymentMethod === null ? null : String(normalized.paymentMethod),
            normalized.deliveryStatus === null ? null : String(normalized.deliveryStatus),
            normalized.orderValue === null ? null : String(normalized.orderValue),
            normalized.currency === null ? null : String(normalized.currency),
          ];
          const output = `${fields.map(csvField).join(",")}\n`;
          rowSerializationMs += performance.now() - rowStartedAt;
          chunk += output;
          bufferedRows += 1;
          if (bufferedRows === 500) {
            yield chunk;
            chunk = "";
            bufferedRows = 0;
          }
        }
        if (chunk) yield chunk;
      }

      const copyStartedAt = performance.now();
      const stageCopy = this.client.query(copyFrom(`
        COPY reconcileos_order_import_stage (
          row_number, raw_data, normalized_data, validation_errors,
          duplicate_in_file, external_id, order_date, delivered_at,
          settlement_due_at, payment_method, delivery_status, order_value,
          currency
        )
        FROM STDIN WITH (FORMAT CSV, NULL '\\N')
      `));
      await pipeline(
        Readable.from(stageCopyRows()),
        stageCopy,
      );
      metrics.stageCopyMs = performance.now() - copyStartedAt;
      metrics.serializationMs = rowSerializationMs;

      const orderInsertStartedAt = performance.now();
      const insertedOrders = await this.client.query<{ id: string; external_id: string }>(
        `
          INSERT INTO orders (
            id, channel_partner_id, external_id, order_date, delivered_at,
            settlement_due_at, payment_method, delivery_status, order_value,
            currency, updated_at
          )
          SELECT
            gen_random_uuid(),
            $1::uuid,
            external_id,
            order_date::timestamptz,
            delivered_at::timestamptz,
            settlement_due_at::timestamptz,
            payment_method::"PaymentMethod",
            delivery_status::"OrderDeliveryStatus",
            order_value::numeric(14, 2),
            currency,
            now()
          FROM reconcileos_order_import_stage
          WHERE validation_errors = '[]'::jsonb
            AND duplicate_in_file = false
          ON CONFLICT (channel_partner_id, external_id) DO NOTHING
          RETURNING id, external_id
        `,
        [input.partnerId],
      );
      metrics.orderInsertMs = performance.now() - orderInsertStartedAt;
      const insertedOrderIds = new Map(
        insertedOrders.rows.map((order) => [order.external_id, order.id]),
      );

      async function* importRowCopyRows() {
        let chunk = "";
        let bufferedRows = 0;
        for (const row of pending) {
          const rowStartedAt = performance.now();
          const errors = [...row.normalized.errors];
          const externalId = String(row.normalized.data.externalId ?? "");
          const orderId = insertedOrderIds.get(externalId);
          let status: "INVALID" | "DUPLICATE" | "PROCESSED";
          let validationErrors: string[] | null;
          if (errors.length > 0) {
            status = "INVALID";
            validationErrors = errors;
          } else if (duplicateInFile.has(row.rowNumber) || !orderId) {
            status = "DUPLICATE";
            validationErrors = ["Order ID already exists for this channel."];
          } else {
            status = "PROCESSED";
            validationErrors = null;
          }
          const fields = [
            randomUUID(),
            input.batchId,
            String(row.rowNumber),
            jsonField(maskPersonalData(row.raw)),
            jsonField(row.normalized.data),
            status,
            validationErrors === null ? null : jsonField(validationErrors),
            status === "PROCESSED" ? orderId! : null,
          ];
          chunk += `${fields.map(csvField).join(",")}\n`;
          rowSerializationMs += performance.now() - rowStartedAt;
          bufferedRows += 1;
          if (bufferedRows === 500) {
            yield chunk;
            chunk = "";
            bufferedRows = 0;
          }
        }
        if (chunk) yield chunk;
      }

      const importCopyStartedAt = performance.now();
      const importRowsCopy = this.client.query(copyFrom(`
        COPY import_rows (
          id, batch_id, row_number, raw_data, normalized_data, status,
          validation_errors, order_id
        )
        FROM STDIN WITH (FORMAT CSV, NULL '\\N')
      `));
      await pipeline(
        Readable.from(importRowCopyRows()),
        importRowsCopy,
      );
      metrics.importRowsCopyMs = performance.now() - importCopyStartedAt;
      metrics.serializationMs = rowSerializationMs;
      if (importRowsCopy.rowCount !== pending.length) {
        throw new Error("The import chunk did not persist every staged row.");
      }
      await this.client.query("COMMIT");
      metrics.transactionMs = performance.now() - transactionStartedAt;
      return metrics;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.client.release();
    await this.pool.end();
  }
}
