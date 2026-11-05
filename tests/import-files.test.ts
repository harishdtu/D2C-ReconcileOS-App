import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { previewSourceFile } from "../src/lib/imports/files";

describe("import file parsing", () => {
  it("parses CSV with quoted commas and masks personal data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reconcileos-csv-"));
    const file = path.join(directory, "orders.csv");
    try {
      await writeFile(
        file,
        'Order ID,Customer Name,Customer Phone,Value\r\nORD-1,"A, Customer",9876543210,1200.00\r\n',
      );
      const preview = await previewSourceFile(file, "csv");
      expect(preview.totalRows).toBe(1);
      expect(preview.rows[0]["Customer Name"]).toBe("A, Customer");
      const { maskPersonalData } = await import("../src/lib/imports/files");
      expect(maskPersonalData(preview.rows[0])["Customer Phone"]).toBe("[REDACTED]");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses the first worksheet from XLSX", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Orders");
    sheet.addRow(["Order ID", "Value"]);
    sheet.addRow(["ORD-2", 1499.25]);
    const bytes = await workbook.xlsx.writeBuffer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "reconcileos-xlsx-"));
    const file = path.join(directory, "orders.xlsx");
    try {
      await writeFile(file, Buffer.from(bytes));
      const preview = await previewSourceFile(file, "xlsx");
      expect(preview.headers).toEqual(["Order ID", "Value"]);
      expect(preview.totalRows).toBe(1);
      expect(preview.rows[0]["Value"]).toBe("1499.25");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate headers rather than silently overwriting a source column", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reconcileos-bad-csv-"));
    const file = path.join(directory, "orders.csv");
    try {
      await writeFile(file, "Order ID,Order ID\nORD-1,ORD-1\n");
      await expect(previewSourceFile(file, "csv")).rejects.toThrow(
        "duplicate column headers",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
