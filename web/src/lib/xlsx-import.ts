import * as XLSX from "xlsx";
import { parseCsvImport, type CsvImportField } from "./csv-import";

export type XlsxSheetStatus = "ready" | "empty" | "invalid";

export type ParsedXlsxSheet = {
  name: string;
  status: XlsxSheetStatus;
  issue: string | null;
  fields: CsvImportField[];
  rows: string[][];
  previewRows: string[][];
};

export type ParsedXlsxImport = {
  fileName: string;
  workbookName: string;
  sheets: ParsedXlsxSheet[];
};

export function parseXlsxImport(data: ArrayBuffer | Uint8Array, fileName: string): ParsedXlsxImport {
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const visibility = new Map(
    (workbook.Workbook?.Sheets ?? []).map((sheet) => [sheet.name, sheet.Hidden ?? 0]),
  );
  const sheets = workbook.SheetNames
    .filter((name) => visibility.get(name) !== 1 && visibility.get(name) !== 2)
    .map((name) => parseSheet(name, workbook.Sheets[name]!));

  return {
    fileName,
    workbookName: fileName.replace(/\.xlsx$/iu, "").trim() || "导入的工作簿",
    sheets,
  };
}

function parseSheet(name: string, worksheet: XLSX.WorkSheet): ParsedXlsxSheet {
  if (!worksheet["!ref"]) return emptySheet(name);
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
  });
  const rows = rawRows.map((row) => row.map(formatCell));
  if (!rows.length || rows[0]!.every((cell) => !cell.trim())) return emptySheet(name);

  const headers = rows[0]!.map((header) => header.trim());
  const duplicates = [...new Set(headers.filter((header, index) =>
    header && headers.indexOf(header) !== index))];
  if (duplicates.length) {
    return {
      name,
      status: "invalid",
      issue: `存在重复表头：${duplicates.join("、")}`,
      fields: [],
      rows: rows.slice(1),
      previewRows: rows.slice(1, 21),
    };
  }

  const parsed = parseCsvImport(toCsv(rows), `${name}.csv`);
  return {
    name,
    status: "ready",
    issue: null,
    fields: parsed.fields,
    rows: parsed.rows,
    previewRows: parsed.previewRows,
  };
}

function emptySheet(name: string): ParsedXlsxSheet {
  return {
    name,
    status: "empty",
    issue: "Sheet 为空",
    fields: [],
    rows: [],
    previewRows: [],
  };
}

function formatCell(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value == null ? "" : String(value);
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => {
    if (!/[",\r\n]/u.test(cell)) return cell;
    return `"${cell.replace(/"/gu, '""')}"`;
  }).join(",")).join("\n");
}
