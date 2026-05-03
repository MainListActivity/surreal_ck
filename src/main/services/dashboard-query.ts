import { RecordId, DateTime } from "surrealdb";
import { getLocalDb } from "../db/index";
import type {
  DashboardCacheDTO,
  DashboardNormalizedResult,
  DashboardPreviewResponse,
  DashboardResultContract,
} from "../../shared/rpc.types";
import { ServiceError } from "./errors";

const BANNED_KEYWORDS = [
  "DEFINE",
  "REMOVE",
  "CREATE",
  "UPDATE",
  "UPSERT",
  "DELETE",
  "RELATE",
  "INSERT",
  "LIVE",
  "USE",
  "LET",
  "BEGIN",
  "COMMIT",
  "CANCEL",
];

export function validateReadOnlyDashboardSql(sql: string, contract: DashboardResultContract): string {
  const trimmed = sql.trim().replace(/;+$/g, "");
  if (!trimmed) throw new ServiceError("VALIDATION_ERROR", "SQL 不能为空");

  const scrubbed = scrubSql(trimmed);
  if (scrubbed.includes(";")) {
    throw new ServiceError("VALIDATION_ERROR", "仅允许单条 SQL 语句");
  }
  if (!/^(SELECT|RETURN)\b/i.test(trimmed)) {
    throw new ServiceError("VALIDATION_ERROR", "仪表盘仅支持只读 SELECT/RETURN 语句");
  }
  for (const keyword of BANNED_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(scrubbed)) {
      throw new ServiceError("VALIDATION_ERROR", `仪表盘 SQL 不允许包含 ${keyword}`);
    }
  }
  if (requiresLimit(contract) && !/\bLIMIT\b/i.test(scrubbed)) {
    throw new ServiceError("VALIDATION_ERROR", "当前结果类型要求 SQL 显式带 LIMIT");
  }
  return trimmed;
}

export function extractSourceTables(sql: string): string[] {
  const scrubbed = scrubSql(sql);
  const tables = new Set<string>();
  for (const match of scrubbed.matchAll(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    tables.add(match[1]);
  }
  for (const match of scrubbed.matchAll(/\bONLY\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
    tables.add(match[1]);
  }
  return [...tables];
}

export async function runDashboardPreview(
  sql: string,
  contract: DashboardResultContract,
  displaySpec: Record<string, unknown> = {},
): Promise<DashboardPreviewResponse> {
  const normalizedSql = validateReadOnlyDashboardSql(sql, contract);
  const db = getLocalDb();
  const started = performance.now();
  const raw = await db.query<unknown[]>(normalizedSql);
  const durationMs = Math.round(performance.now() - started);
  const result = normalizeDashboardResult(raw, contract, displaySpec);
  const rowsCount = countRows(result, contract);
  const sourceTables = extractSourceTables(normalizedSql);
  return {
    sql: normalizedSql,
    sourceTables,
    dependencies: [...sourceTables],
    durationMs,
    rowsCount,
    result,
    resultMeta: { contract },
    sqlHash: Bun.hash.wyhash(normalizedSql).toString(16).padStart(16, "0"),
  };
}

export function toDashboardCacheDTO(
  viewId: string,
  preview: DashboardPreviewResponse,
  overrides?: Partial<Pick<DashboardCacheDTO, "status" | "errorDetail">>,
): DashboardCacheDTO {
  return {
    viewId,
    status: overrides?.status ?? "ok",
    rowsCount: preview.rowsCount,
    durationMs: preview.durationMs,
    executedAt: new Date().toISOString(),
    sqlHash: preview.sqlHash,
    result: preview.result,
    resultMeta: preview.resultMeta,
    errorDetail: overrides?.errorDetail,
  };
}

export function normalizeDashboardResult(
  raw: unknown[],
  contract: DashboardResultContract,
  displaySpec: Record<string, unknown> = {},
): DashboardNormalizedResult {
  const rows = extractRows(raw).map((row) => jsonifyValue(row)) as Array<Record<string, unknown>>;
  switch (contract) {
    case "single_value": {
      const row = rows[0] ?? {};
      const value = row.value ?? firstScalarValue(row) ?? null;
      return {
        value: value as string | number | boolean | null,
        label: asOptionalString(displaySpec.label) ?? asOptionalString(row.label),
        unit: asOptionalString(displaySpec.unit),
        delta: typeof row.delta === "number" ? row.delta : null,
      };
    }
    case "category_breakdown":
      return {
        rows: rows.map((row, idx) => ({
          key: String(row.key ?? row.label ?? idx),
          label: String(row.label ?? row.key ?? idx),
          value: toFiniteNumber(row.value),
        })),
      };
    case "time_series":
      return {
        rows: rows.map((row) => ({
          x: String(row.x ?? row.date ?? row.label ?? ""),
          y: toFiniteNumber(row.y ?? row.value),
          series: row.series ? String(row.series) : undefined,
        })),
      };
    case "table_rows": {
      const first = rows[0] ?? {};
      const columns = Object.keys(first).map((key) => ({
        key,
        label: prettifyColumnLabel(key),
      }));
      return { columns, rows };
    }
  }
}

function requiresLimit(contract: DashboardResultContract): boolean {
  return contract !== "single_value";
}

function scrubSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
}

function extractRows(raw: unknown[]): Array<Record<string, unknown>> {
  for (const statement of raw) {
    if (Array.isArray(statement)) {
      return statement.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
    }
    if (statement && typeof statement === "object" && !Array.isArray(statement)) {
      return [statement as Record<string, unknown>];
    }
  }
  return [];
}

function jsonifyValue(value: unknown): unknown {
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) return String(value);
  if (Array.isArray(value)) return value.map((item) => jsonifyValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonifyValue(item)]));
  }
  return value;
}

function firstScalarValue(row: Record<string, unknown>): unknown {
  for (const value of Object.values(row)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  }
  return null;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function prettifyColumnLabel(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function countRows(result: DashboardNormalizedResult, contract: DashboardResultContract): number {
  switch (contract) {
    case "single_value":
      return 1;
    case "category_breakdown":
    case "time_series":
      return "rows" in result ? result.rows.length : 0;
    case "table_rows":
      return "rows" in result ? result.rows.length : 0;
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
