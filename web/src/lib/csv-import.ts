import type { GridFieldType } from "@surreal-ck/shared/field-schema";

export type CsvImportFieldType = Extract<GridFieldType, "text" | "number" | "decimal" | "date">;

export type CsvImportField = {
  key: string;
  label: string;
  fieldType: CsvImportFieldType;
  sourceIndex: number;
};

export type ParsedCsvImport = {
  fileName: string;
  workbookName: string;
  fields: CsvImportField[];
  rows: string[][];
  previewRows: string[][];
};

export type SkippedCsvRow = {
  rowNumber: number;
  reason: string;
};

export type ConvertedCsvImport = {
  records: Array<Record<string, unknown>>;
  skipped: SkippedCsvRow[];
};

const MONEY_HEADER = /(金额|价款|价格|费用|余额|收入|支出|成本|单价|合计|总计)/;
const CURRENCY_MARK = /[￥¥$€£]/;
const NUMBER_LITERAL = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

export function parseCsvImport(source: string, fileName: string): ParsedCsvImport {
  const rows = parseCsvRows(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  if (rows.length === 0 || rows[0]!.every((cell) => cell.trim() === "")) {
    throw new Error("CSV 缺少表头");
  }

  const header = rows[0]!;
  const dataRows = rows.slice(1).map((row) => normalizeRowWidth(row, header.length));
  const fields = header.map((label, sourceIndex): CsvImportField => {
    const finalLabel = label.trim() || `字段 ${sourceIndex + 1}`;
    const values = dataRows.map((row) => row[sourceIndex] ?? "");
    return {
      key: `field_${sourceIndex + 1}`,
      label: finalLabel,
      fieldType: inferFieldType(finalLabel, values),
      sourceIndex,
    };
  });

  const workbookName = fileName.replace(/\.csv$/i, "").trim() || "导入的工作簿";
  return {
    fileName,
    workbookName,
    fields,
    rows: dataRows,
    previewRows: dataRows.slice(0, 20),
  };
}

export function convertCsvImportRows(
  rows: string[][],
  fields: CsvImportField[],
): ConvertedCsvImport {
  const records: Array<Record<string, unknown>> = [];
  const skipped: SkippedCsvRow[] = [];

  for (const [index, row] of rows.entries()) {
    if (row.every((cell) => cell.trim() === "")) {
      skipped.push({ rowNumber: index + 2, reason: "空白记录" });
      continue;
    }

    const record: Record<string, unknown> = {};
    let failure: string | null = null;
    for (const field of fields) {
      const raw = row[field.sourceIndex]?.trim() ?? "";
      if (!raw) continue;
      const converted = convertValue(raw, field.fieldType);
      if (!converted.ok) {
        failure = `字段“${field.label.trim() || field.key}”${converted.reason}`;
        break;
      }
      record[field.key] = converted.value;
    }

    if (failure) skipped.push({ rowNumber: index + 2, reason: failure });
    else records.push(record);
  }

  return { records, skipped };
}

function parseCsvRows(source: string): string[][] {
  if (!source) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && source[index + 1] === "\n") index += 1;
    } else cell += char;
  }

  if (quoted) throw new Error("CSV 中存在未闭合的引号");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function normalizeRowWidth(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function inferFieldType(label: string, values: string[]): CsvImportFieldType {
  const present = values.map((value) => value.trim()).filter(Boolean);
  if (present.length === 0) return "text";
  if (present.every((value) => parseDateValue(value) !== null)) return "date";
  if (present.every((value) => parseNumericValue(value) !== null)) {
    const decimal = MONEY_HEADER.test(label)
      || present.some((value) => CURRENCY_MARK.test(value) || value.replace(/,/g, "").includes("."));
    return decimal ? "decimal" : "number";
  }
  return "text";
}

function parseNumericValue(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/[￥¥$€£\s]/g, "");
  if (!NUMBER_LITERAL.test(normalized)) return null;
  const result = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(result) ? result : null;
}

function parseDateValue(value: string): Date | null {
  const match = value.trim().match(/^(\d{4})(?:[-/年])(\d{1,2})(?:[-/月])(\d{1,2})(?:日)?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function convertValue(
  value: string,
  fieldType: CsvImportFieldType,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (fieldType === "text") return { ok: true, value };
  if (fieldType === "date") {
    const date = parseDateValue(value);
    return date ? { ok: true, value: date } : { ok: false, reason: "不是有效日期" };
  }
  const number = parseNumericValue(value);
  if (number === null) {
    return { ok: false, reason: fieldType === "number" ? "不是有效整数" : "不是有效金额/小数" };
  }
  if (fieldType === "number" && !Number.isInteger(number)) {
    return { ok: false, reason: "不是有效整数" };
  }
  return { ok: true, value: number };
}
