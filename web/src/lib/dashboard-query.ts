import type {
  DashboardBuilderSpec,
  DashboardNormalizedResult,
  DashboardPreviewResponse,
  DashboardResultContract,
  DashboardViewType,
} from "@surreal-ck/shared/rpc.types";
import type { DashboardWidget } from "./dashboard-data";
import type { SurrealConn } from "./surreal";

export type DashboardCompiledWidgetQuery = {
  sql: string;
  bindings: Record<string, unknown>;
  sourceTables: string[];
  dependencies: string[];
  resultContract: DashboardResultContract;
  viewType: DashboardViewType;
  displaySpec: Record<string, unknown>;
};

export type DashboardWidgetQueryInput =
  | DashboardBuilderSpec
  | Pick<DashboardWidget, "spec" | "viewType" | "display">;

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateDashboardWidgetSpec(spec: DashboardBuilderSpec): void {
  if (!Array.isArray(spec.sourceTables) || spec.sourceTables.length === 0) {
    throw new Error("至少选择一个数据表");
  }
  for (const table of spec.sourceTables) {
    assertSafeIdentifier(table, "非法的数据表名");
  }
  assertSafeIdentifier(spec.baseTable, "非法的数据表名");
  if (!spec.metric?.op) {
    throw new Error("缺少统计指标");
  }
  if (spec.metric.field) {
    assertSafeIdentifier(spec.metric.field, "非法的指标字段");
  }
  if (spec.metric.op !== "count" && !spec.metric.field) {
    throw new Error("当前统计方式需要选择字段");
  }
  for (const dimension of spec.dimensions ?? []) {
    assertSafeIdentifier(dimension.field, "非法的分组字段");
  }
  for (const filter of spec.filters ?? []) {
    assertSafeIdentifier(filter.field, "非法的筛选字段");
  }
  if (spec.sort) {
    assertSafeIdentifier(spec.sort.field, "非法的排序字段");
  }
}

export function compileDashboardWidgetQuery(
  input: DashboardWidgetQueryInput,
): DashboardCompiledWidgetQuery {
  const { spec, viewType, display } = normalizeQueryInput(input);
  validateDashboardWidgetSpec(spec);
  const sourceTables = spec.sourceTables.length ? spec.sourceTables : [spec.baseTable];
  const dimension = spec.dimensions?.[0];
  const limit = normalizeLimit(spec.limit);
  const bindings: Record<string, unknown> = { tb: spec.baseTable };
  const where = compileWhere(spec.filters ?? [], bindings);
  if (viewType === "table") {
    const columns = normalizeTableColumns(display);
    const orderBy = spec.sort
      ? ` ORDER BY ${spec.sort.field} ${spec.sort.direction.toUpperCase()}`
      : "";
    return {
      sql: `SELECT ${columns.map((column) => column.key).join(", ")} FROM type::table($tb)${where}${orderBy} LIMIT ${limit}`,
      bindings,
      sourceTables,
      dependencies: Array.from(new Set([spec.baseTable, ...sourceTables])),
      resultContract: "table_rows",
      viewType,
      displaySpec: withDisplay(display, { columns }),
    };
  }
  if (dimension?.bucket) {
    const bucketSql = compileBucketExpr(dimension.field, dimension.bucket);
    const metricSql = compileMetricExpr(spec.metric);
    const orderBy = compileOrderBy(spec.sort, "x", "asc", {
      [dimension.field]: "x",
      value: "y",
      y: "y",
      x: "x",
    });
    return {
      sql: `SELECT ${bucketSql} AS x, ${metricSql} AS y FROM type::table($tb)${where} GROUP BY x ${orderBy} LIMIT ${limit}`,
      bindings,
      sourceTables,
      dependencies: Array.from(new Set([spec.baseTable, ...sourceTables])),
      resultContract: "time_series",
      viewType: viewType ?? "line",
      displaySpec: withDisplay(display, {
        xLabel: dimension.field,
        yLabel: metricLabel(spec.metric.op, spec.metric.field),
      }),
    };
  }
  if (dimension && !dimension.bucket) {
    const metricSql = compileMetricExpr(spec.metric);
    const orderBy = compileOrderBy(spec.sort, "value", "desc");
    return {
      sql: `SELECT ${dimension.field} AS key, string::concat(${dimension.field} ?? '') AS label, ${metricSql} AS value FROM type::table($tb)${where} GROUP BY ${dimension.field} ${orderBy} LIMIT ${limit}`,
      bindings,
      sourceTables,
      dependencies: Array.from(new Set([spec.baseTable, ...sourceTables])),
      resultContract: "category_breakdown",
      viewType: viewType ?? "bar",
      displaySpec: withDisplay(display, {
        categoryLabel: dimension.field,
        metricLabel: metricLabel(spec.metric.op, spec.metric.field),
      }),
    };
  }

  if (spec.metric.op === "count_distinct") {
    const field = spec.metric.field;
    if (!field) throw new Error("去重计数需要字段");
    return {
      sql: `SELECT count() AS value FROM (SELECT ${field} FROM type::table($tb)${where} GROUP BY ${field}) GROUP ALL LIMIT 1`,
      bindings,
      sourceTables,
      dependencies: Array.from(new Set([spec.baseTable, ...sourceTables])),
      resultContract: "single_value",
      viewType: viewType ?? "kpi",
      displaySpec: withDisplay(display, {
        metricLabel: metricLabel(spec.metric.op, field),
      }),
    };
  }

  const metricSql = compileMetricExpr(spec.metric);
  return {
    sql: `SELECT ${metricSql} AS value FROM type::table($tb)${where} GROUP ALL LIMIT 1`,
    bindings,
    sourceTables,
    dependencies: Array.from(new Set([spec.baseTable, ...sourceTables])),
    resultContract: "single_value",
    viewType: viewType ?? "kpi",
    displaySpec: withDisplay(display, {
      metricLabel: metricLabel(spec.metric.op, spec.metric.field),
    }),
  };
}

export async function runDashboardWidgetQuery(
  conn: SurrealConn,
  input: DashboardWidgetQueryInput,
): Promise<DashboardPreviewResponse> {
  const compiled = compileDashboardWidgetQuery(input);
  const started = performance.now();
  const rows = await conn.query<Record<string, unknown>>(compiled.sql, compiled.bindings);
  const durationMs = Math.round(performance.now() - started);
  const result = normalizeDashboardResult(rows, compiled.resultContract, compiled.displaySpec);
  return {
    sql: compiled.sql,
    sourceTables: compiled.sourceTables,
    dependencies: compiled.dependencies,
    durationMs,
    rowsCount: countRows(result, compiled.resultContract),
    result,
    resultMeta: { contract: compiled.resultContract, viewType: compiled.viewType },
    sqlHash: hashSql(compiled.sql),
  };
}

function normalizeQueryInput(input: DashboardWidgetQueryInput): {
  spec: DashboardBuilderSpec;
  viewType?: DashboardViewType;
  display?: Record<string, unknown>;
} {
  if ("spec" in input) {
    return { spec: input.spec, viewType: input.viewType, display: input.display };
  }
  return { spec: input };
}

function withDisplay(
  display: Record<string, unknown> | undefined,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return { ...defaults, ...(display ?? {}) };
}

function normalizeDashboardResult(
  rows: Array<Record<string, unknown>>,
  contract: DashboardResultContract,
  displaySpec: Record<string, unknown>,
): DashboardNormalizedResult {
  if (contract === "category_breakdown") {
    return {
      rows: rows.map((row, idx) => ({
        key: String(row.key ?? row.label ?? idx),
        label: String(row.label ?? row.key ?? idx),
        value: toFiniteNumber(row.value),
      })),
    };
  }
  if (contract === "time_series") {
    return {
      rows: rows.map((row) => ({
        x: String(row.x ?? row.date ?? row.label ?? ""),
        y: toFiniteNumber(row.y ?? row.value),
        ...(row.series ? { series: String(row.series) } : {}),
      })),
    };
  }
  if (contract !== "single_value") {
    const columns = Array.isArray(displaySpec.columns)
      ? displaySpec.columns.filter(isTableColumn)
      : [];
    return { columns, rows };
  }
  const row = rows[0] ?? {};
  return {
    value: (row.value ?? firstScalarValue(row) ?? null) as string | number | boolean | null,
    ...(typeof displaySpec.metricLabel === "string" ? { label: displaySpec.metricLabel } : {}),
  };
}

function firstScalarValue(row: Record<string, unknown>): unknown {
  for (const value of Object.values(row)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  }
  return null;
}

function countRows(
  result: DashboardNormalizedResult,
  contract: DashboardResultContract,
): number {
  if (contract === "single_value") return 1;
  if ("rows" in result) return result.rows.length;
  return 0;
}

/** 指标的中文标签；编译器 displaySpec 与 builder 自动标题共用同一份词汇。 */
export function metricLabel(op: DashboardBuilderSpec["metric"]["op"], field?: string): string {
  if (op === "count") return "记录数";
  if (op === "count_distinct") return field ? `${field} 去重数` : "去重数";
  if (op === "sum") return field ? `${field} 总和` : "总和";
  return field ? `${field} ${op}` : op;
}

function compileMetricExpr(metric: DashboardBuilderSpec["metric"]): string {
  if (metric.op === "count") return "count()";
  if (!metric.field) throw new Error("当前统计方式需要选择字段");
  return compileAggregate(metric.op, metric.field);
}

function compileAggregate(op: DashboardBuilderSpec["metric"]["op"], field: string): string {
  switch (op) {
    case "sum":
      return `math::sum(${field})`;
    case "avg":
      return `math::mean(${field})`;
    case "min":
      return `math::min(${field})`;
    case "max":
      return `math::max(${field})`;
    case "count_distinct":
      return `count(array::distinct(array::group(${field})))`;
    default:
      throw new Error(`暂不支持的指标类型: ${op}`);
  }
}

function normalizeLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 20, 200));
}

function compileOrderBy(
  sort: DashboardBuilderSpec["sort"] | undefined,
  fallbackField: string,
  fallbackDirection: "asc" | "desc",
  aliases: Record<string, string> = {},
): string {
  const field = sort ? aliases[sort.field] ?? sort.field : fallbackField;
  const direction = (sort?.direction ?? fallbackDirection).toUpperCase();
  return `ORDER BY ${field} ${direction}`;
}

function compileBucketExpr(
  field: string,
  bucket: NonNullable<NonNullable<DashboardBuilderSpec["dimensions"]>[number]["bucket"]>,
): string {
  const format = {
    day: "%Y-%m-%d",
    week: "%G-W%V",
    month: "%Y-%m",
    year: "%Y",
  }[bucket];
  return `time::format(${field}, ${JSON.stringify(format)})`;
}

const FILTER_COMPARATORS = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
} as const;

function compileWhere(
  filters: NonNullable<DashboardBuilderSpec["filters"]>,
  bindings: Record<string, unknown>,
): string {
  const pieces: string[] = [];
  for (const filter of filters) {
    switch (filter.op) {
      case "is_null":
        pieces.push(`${filter.field} IS NULL`);
        break;
      case "is_not_null":
        pieces.push(`${filter.field} IS NOT NULL`);
        break;
      case "in":
        if (Array.isArray(filter.value) && filter.value.length) {
          const key = `f${pieces.length}`;
          bindings[key] = filter.value;
          pieces.push(`${filter.field} INSIDE $${key}`);
        }
        break;
      case "contains":
        if (hasFilterValue(filter.value)) {
          const key = `f${pieces.length}`;
          bindings[key] = filter.value;
          pieces.push(`${filter.field} CONTAINS $${key}`);
        }
        break;
      default: {
        const op = FILTER_COMPARATORS[filter.op];
        if (op && hasFilterValue(filter.value)) {
          const key = `f${pieces.length}`;
          bindings[key] = filter.value;
          pieces.push(`${filter.field} ${op} $${key}`);
        }
      }
    }
  }
  return pieces.length ? ` WHERE ${pieces.join(" AND ")}` : "";
}

function hasFilterValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function normalizeTableColumns(
  display: Record<string, unknown> | undefined,
): Array<{ key: string; label: string }> {
  const columns = Array.isArray(display?.columns)
    ? display.columns.filter(isTableColumn)
    : [];
  if (columns.length === 0) throw new Error("列表组件至少需要一个展示字段");
  for (const column of columns) assertSafeIdentifier(column.key, "非法的列表字段");
  return columns;
}

function isTableColumn(value: unknown): value is { key: string; label: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const column = value as Record<string, unknown>;
  return typeof column.key === "string" && typeof column.label === "string";
}

function assertSafeIdentifier(value: string, message: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${message}: ${value}`);
  }
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function hashSql(sql: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sql.length; i += 1) {
    hash ^= sql.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
