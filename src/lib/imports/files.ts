import { createReadStream } from "node:fs";
import ExcelJS from "exceljs";
import { parse } from "csv-parse";

export type SourceRow = Record<string, string>;

export type FilePreview = {
  headers: string[];
  rows: SourceRow[];
  totalRows: number;
};

function normalizeHeaders(headers: string[]): string[] {
  const normalized = headers.map((header) => header.trim());
  if (normalized.length === 0 || normalized.some((header) => !header)) {
    throw new Error("The file must have non-empty column headers.");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("The file contains duplicate column headers.");
  }
  return normalized;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text).join("");
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export async function* readSourceRows(
  filePath: string,
  extension: "csv" | "xlsx",
): AsyncGenerator<{ rowNumber: number; row: SourceRow }> {
  if (extension === "csv") {
    const parser = createReadStream(filePath).pipe(
      parse({
        bom: true,
        columns: (headers: string[]) => normalizeHeaders(headers),
        skip_empty_lines: true,
        trim: true,
        max_record_size: 1024 * 1024,
      }),
    );
    let rowNumber = 2;
    for await (const record of parser) {
      yield {
        rowNumber,
        row: Object.fromEntries(
          Object.entries(record as Record<string, unknown>).map(([key, value]) => [
            key,
            value === null || value === undefined ? "" : String(value).trim(),
          ]),
        ),
      };
      rowNumber += 1;
    }
    return;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The workbook has no worksheet.");

  const headerRow = worksheet.getRow(1);
  const headers = normalizeHeaders(
    Array.from({ length: headerRow.cellCount }, (_, index) =>
      cellToString(headerRow.getCell(index + 1).value),
    ),
  );
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells = Array.from({ length: headers.length }, (_, index) =>
      row.getCell(index + 1).value,
    );
    if (cells.every((cell) => cell === null || cell === undefined || cell === "")) {
      continue;
    }
    yield {
      rowNumber,
      row: Object.fromEntries(
        headers.map((header, index) => [
          header,
          cellToString(cells[index] as ExcelJS.CellValue).trim(),
        ]),
      ),
    };
  }
}

export async function previewSourceFile(
  filePath: string,
  extension: "csv" | "xlsx",
): Promise<FilePreview> {
  const rows: SourceRow[] = [];
  let headers: string[] | undefined;
  let totalRows = 0;
  for await (const record of readSourceRows(filePath, extension)) {
    headers ??= Object.keys(record.row);
    totalRows += 1;
    if (rows.length < 20) rows.push(record.row);
  }
  if (!headers) {
    if (extension === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const first = workbook.worksheets[0]?.getRow(1);
      if (first) {
        headers = normalizeHeaders(
          Array.from({ length: first.cellCount }, (_, index) =>
            cellToString(first.getCell(index + 1).value),
          ),
        );
      }
    } else {
      const parser = createReadStream(filePath).pipe(
        parse({ bom: true, to_line: 1, relax_column_count: false }),
      );
      for await (const header of parser) {
        headers = normalizeHeaders((header as string[]).map(String));
        break;
      }
    }
  }
  if (!headers) throw new Error("The file is empty or has no header row.");
  return { headers, rows, totalRows };
}

export function maskPersonalData(row: SourceRow): SourceRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      /\b(name|phone|mobile|address|email)\b/i.test(key) ? "[REDACTED]" : value,
    ]),
  );
}
