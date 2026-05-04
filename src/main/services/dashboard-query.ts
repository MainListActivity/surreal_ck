import { getLocalDb } from "../db/index";
import type {
  DashboardCacheDTO,
  DashboardNormalizedResult,
  DashboardPreviewResponse,
  DashboardResultContract,
} from "../../shared/rpc.types";
import { ServiceError } from "./errors";

/**
 * 真正可能改数据的 SurrealQL 关键字。SurrealDB 通过登录身份的 PERMISSIONS 控制
 * 用户能改什么——这里的检测目的不是隔绝权限,而是在用户手写 SQL 时提示
 * "你这条 SQL 可能会改自己的数据"。
 */
const MUTATION_KEYWORDS = [
  "DEFINE",
  "REMOVE",
  "CREATE",
  "UPDATE",
  "UPSERT",
  "DELETE",
  "RELATE",
  "INSERT",
];

/** 检测 SQL 中是否含有可能改数据的关键字。返回命中关键字数组(可能为空)。 */
export function assessSqlMutationRisk(sql: string): { keywords: string[] } {
  const scrubbed = scrubSql(sql);
  const hits: string[] = [];
  for (const keyword of MUTATION_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(scrubbed)) hits.push(keyword);
  }
  return { keywords: hits };
}

/**
 * 仪表盘 SQL 的硬性参数验证:必须非空、必须单条、必须 SELECT/RETURN 开头、
 * 当结果契约要求 LIMIT 时必须带 LIMIT。这些是"输入形态合法性",
 * 与 mutation 风险无关——用户哪怕确认风险也无法绕过。
 */
export function validateDashboardSqlShape(sql: string, contract: DashboardResultContract): string {
  const trimmed = sql.trim().replace(/;+$/g, "");
  if (!trimmed) throw new ServiceError("VALIDATION_ERROR", "SQL 不能为空");

  const scrubbed = scrubSql(trimmed);
  if (scrubbed.includes(";")) {
    throw new ServiceError("VALIDATION_ERROR", "仅允许单条 SQL 语句");
  }
  if (!/^(SELECT|RETURN)\b/i.test(trimmed)) {
    throw new ServiceError("VALIDATION_ERROR", "仪表盘 SQL 必须以 SELECT 或 RETURN 开头");
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
  options: { confirmRisk?: boolean } = {},
): Promise<DashboardPreviewResponse> {
  const normalizedSql = validateDashboardSqlShape(sql, contract);
  if (!options.confirmRisk) {
    const risk = assessSqlMutationRisk(normalizedSql);
    if (risk.keywords.length) {
      throw new ServiceError(
        "SQL_MUTATION_WARNING",
        `SQL 中包含可能修改数据的关键字: ${risk.keywords.join(", ")}`,
      );
    }
  }
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
  const rows = extractRows(raw);
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
