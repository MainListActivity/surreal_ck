import type { GridColumnDef } from "@surreal-ck/shared/rpc.types";
import { validateGridFieldValue } from "@surreal-ck/shared/field-schema";
import type { ParsedCsvImport } from "./csv-import";

export type TemplateImportTarget = {
  column: GridColumnDef;
  aliases?: string[];
};

export type TemplateImportMapping = {
  sourceIndex: number;
  sourceLabel: string;
  targetKey: string | null;
  matchedBy: "field-name" | "alias" | "relaxed" | null;
};

export type TemplateImportRecord = {
  rowNumber: number;
  values: Record<string, unknown>;
  sourceCells: string[];
};

export type TemplateImportRejectedRow = {
  rowNumber: number;
  field: string;
  reason: string;
  sourceCells: string[];
};

export type NormalizeTemplateImportInput = {
  rows: string[][];
  rowNumbers?: number[];
  mappings: TemplateImportMapping[];
  targets: TemplateImportTarget[];
  referenceMatches?: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
};

export type NormalizedTemplateImport = {
  records: TemplateImportRecord[];
  rejected: TemplateImportRejectedRow[];
};

export type TemplateImportExecutionInput = {
  rows: string[][];
  rowNumbers?: number[];
  mappings: TemplateImportMapping[];
};

export type TemplateImportExecutionResult = {
  importedCount: number;
  rejected: TemplateImportRejectedRow[];
};

export type TemplateSheetImportControllerSnapshot = {
  mappings: TemplateImportMapping[];
  importedCount: number;
  rejected: TemplateImportRejectedRow[];
  importing: boolean;
  error: string | null;
};

const CURRENCY_MARK = /[￥¥$€£]/gu;
const NUMBER_LITERAL = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

export function createTemplateSheetImportController(input: {
  parsed: ParsedCsvImport;
  targets: TemplateImportTarget[];
  importRows: (input: TemplateImportExecutionInput) => Promise<TemplateImportExecutionResult>;
}) {
  let mappings = mapCsvHeadersToTemplateFields(
    input.parsed.fields.map((field) => field.label),
    input.targets,
  );
  let importedCount = 0;
  let rejected: TemplateImportRejectedRow[] = [];
  let importing = false;
  let error: string | null = null;

  function snapshot(): TemplateSheetImportControllerSnapshot {
    return {
      mappings: mappings.map((mapping) => ({ ...mapping })),
      importedCount,
      rejected: rejected.map((row) => ({ ...row, sourceCells: [...row.sourceCells] })),
      importing,
      error,
    };
  }

  function setMapping(sourceIndex: number, targetKey: string | null): void {
    mappings = mappings.map((mapping) => {
      if (mapping.sourceIndex === sourceIndex) {
        return { ...mapping, targetKey, matchedBy: null };
      }
      if (targetKey && mapping.targetKey === targetKey) {
        return { ...mapping, targetKey: null, matchedBy: null };
      }
      return mapping;
    });
  }

  function updateRejectedCell(rowNumber: number, sourceIndex: number, value: string): void {
    rejected = rejected.map((row) => row.rowNumber === rowNumber
      ? {
          ...row,
          sourceCells: row.sourceCells.map((cell, index) => index === sourceIndex ? value : cell),
        }
      : row);
  }

  async function execute(executionInput: TemplateImportExecutionInput, retry: boolean): Promise<void> {
    if (importing) return;
    importing = true;
    error = null;
    try {
      const result = await input.importRows(executionInput);
      importedCount = retry ? importedCount + result.importedCount : result.importedCount;
      rejected = result.rejected.map((row) => ({ ...row, sourceCells: [...row.sourceCells] }));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      importing = false;
    }
  }

  return {
    get snapshot() { return snapshot(); },
    setMapping,
    updateRejectedCell,
    importAll: () => execute({ rows: input.parsed.rows, mappings }, false),
    retryRejected: () => execute({
      rows: rejected.map((row) => [...row.sourceCells]),
      rowNumbers: rejected.map((row) => row.rowNumber),
      mappings,
    }, true),
  };
}

export function mapCsvHeadersToTemplateFields(
  headers: string[],
  targets: TemplateImportTarget[],
): TemplateImportMapping[] {
  const results: TemplateImportMapping[] = headers.map((sourceLabel, sourceIndex) => ({
    sourceIndex,
    sourceLabel,
    targetKey: null,
    matchedBy: null,
  }));
  const claimedTargets = new Set<string>();

  function claim(
    matchedBy: Exclude<TemplateImportMapping["matchedBy"], null>,
    matches: (sourceLabel: string, target: TemplateImportTarget) => boolean,
  ): void {
    for (const result of results) {
      if (result.targetKey) continue;
      const target = targets.find((candidate) =>
        !claimedTargets.has(candidate.column.key) && matches(result.sourceLabel, candidate));
      if (!target) continue;
      result.targetKey = target.column.key;
      result.matchedBy = matchedBy;
      claimedTargets.add(target.column.key);
    }
  }

  claim("field-name", (sourceLabel, { column }) => column.label === sourceLabel);
  claim("alias", (sourceLabel, { aliases }) => aliases?.includes(sourceLabel) === true);
  claim("relaxed", (sourceLabel, { column, aliases }) => {
    const source = relaxedText(sourceLabel);
    return relaxedText(column.label) === source
      || aliases?.some((alias) => relaxedText(alias) === source) === true;
  });
  return results;
}

export function normalizeTemplateImportRows(
  input: NormalizeTemplateImportInput,
): NormalizedTemplateImport {
  const targetByKey = new Map(input.targets.map((target) => [target.column.key, target]));
  const records: TemplateImportRecord[] = [];
  const rejected: TemplateImportRejectedRow[] = [];

  input.rows.forEach((sourceCells, index) => {
    const rowNumber = input.rowNumbers?.[index] ?? index + 2;
    const values: Record<string, unknown> = {};
    let failure: TemplateImportRejectedRow | null = null;
    for (const mapping of input.mappings) {
      if (!mapping.targetKey) continue;
      const target = targetByKey.get(mapping.targetKey);
      if (!target) continue;
      const raw = sourceCells[mapping.sourceIndex]?.trim() ?? "";
      if (!raw) continue;
      const converted = convertValue(
        raw,
        target.column,
        input.referenceMatches?.get(target.column.key),
      );
      if (!converted.ok) {
        failure = {
          rowNumber,
          field: target.column.label,
          reason: converted.reason,
          sourceCells: [...sourceCells],
        };
        break;
      }
      values[target.column.key] = converted.value;
    }
    if (!failure) {
      for (const { column } of input.targets) {
        const errors = validateGridFieldValue(values[column.key], column);
        if (!errors.length) continue;
        failure = {
          rowNumber,
          field: column.label,
          reason: errors.join("；"),
          sourceCells: [...sourceCells],
        };
        break;
      }
    }
    if (failure) rejected.push(failure);
    else records.push({ rowNumber, values, sourceCells: [...sourceCells] });
  });

  return { records, rejected };
}

function convertValue(
  raw: string,
  column: GridColumnDef,
  referenceMatches?: ReadonlyMap<string, readonly string[]>,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (column.fieldType === "text") return { ok: true, value: raw };
  if (column.fieldType === "date") {
    const date = parseDate(raw);
    return date ? { ok: true, value: date } : { ok: false, reason: `值“${raw}”不是有效日期` };
  }
  if (column.fieldType === "number" || column.fieldType === "decimal") {
    const value = parseNumber(raw);
    if (value === null || (column.fieldType === "number" && !Number.isInteger(value))) {
      return {
        ok: false,
        reason: column.fieldType === "number"
          ? `值“${raw}”不是有效整数`
          : `值“${raw}”不是有效金额/小数`,
      };
    }
    return { ok: true, value };
  }
  if (column.fieldType === "checkbox") {
    const normalized = relaxedText(raw);
    if (["是", "true", "yes", "1", "有"].includes(normalized)) return { ok: true, value: true };
    if (["否", "false", "no", "0", "无"].includes(normalized)) return { ok: true, value: false };
    return { ok: false, reason: `值“${raw}”不是可识别的布尔值` };
  }
  if (column.fieldType === "single_select") {
    const option = column.options?.find((candidate) => relaxedText(candidate) === relaxedText(raw));
    return option
      ? { ok: true, value: option }
      : { ok: false, reason: `值“${raw}”不在可选项中` };
  }
  if (column.fieldType === "reference") {
    const matches = referenceMatches?.get(relaxedText(raw)) ?? [];
    if (matches.length === 1) return { ok: true, value: matches[0] };
    if (matches.length > 1) {
      return { ok: false, reason: `显示值“${raw}”匹配到多条引用记录` };
    }
    return { ok: false, reason: `未找到显示值为“${raw}”的引用记录` };
  }
  return { ok: false, reason: `值“${raw}”无法转换为目标字段类型` };
}

function parseNumber(raw: string): number | null {
  const normalized = raw
    .replace(/^\((.*)\)$/u, "-$1")
    .replace(CURRENCY_MARK, "")
    .replace(/\s+/gu, "");
  if (!NUMBER_LITERAL.test(normalized)) return null;
  const value = Number(normalized.replace(/,/gu, ""));
  return Number.isFinite(value) ? value : null;
}

function parseDate(raw: string): Date | null {
  const match = raw.match(/^(\d{4})(?:[-/.年])(\d{1,2})(?:[-/.月])(\d{1,2})(?:日)?$/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
    ? date
    : null;
}

function relaxedText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, "");
}
