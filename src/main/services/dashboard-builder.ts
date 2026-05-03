import type {
  DashboardBuilderFilterOp,
  DashboardBuilderSpec,
  DashboardResultContract,
  DashboardViewType,
} from "../../shared/rpc.types";
import { ServiceError } from "./errors";

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAFE_TABLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type CompiledBuilder = {
  sql: string;
  sourceTables: string[];
  dependencies: string[];
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  displaySpec: Record<string, unknown>;
};

const SIMPLE_OP_SQL: Record<Exclude<DashboardBuilderFilterOp, "contains" | "in" | "is_null" | "is_not_null">, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export function validateBuilderSpec(spec: DashboardBuilderSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new ServiceError("VALIDATION_ERROR", "缺少 Builder 配置");
  }
  if (!Array.isArray(spec.sourceTables) || spec.sourceTables.length === 0) {
    throw new ServiceError("VALIDATION_ERROR", "至少选择一个数据表");
  }
  for (const table of spec.sourceTables) {
    assertSafeTable(table, "非法的数据表名");
  }
  assertSafeTable(spec.baseTable, "非法的主数据表");

  const metric = spec.metric;
  if (!metric?.op) {
    throw new ServiceError("VALIDATION_ERROR", "缺少统计指标");
  }
  if (metric.op !== "count" && metric.op !== "count_distinct" && !metric.field) {
    throw new ServiceError("VALIDATION_ERROR", "当前统计方式需要选择字段");
  }
  if (metric.field) assertSafeIdentifier(metric.field, "非法的指标字段");

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

export function compileDashboardBuilder(spec: DashboardBuilderSpec): CompiledBuilder {
  validateBuilderSpec(spec);

  const dimension = spec.dimensions?.[0];
  const dependencies = Array.from(new Set([spec.baseTable, ...(spec.sourceTables ?? [])]));
  const limit = normalizeLimit(spec.limit);
  const where = compileWhere(spec.filters ?? []);

  if (dimension?.bucket) {
    const bucketSql = compileBucketExpr(dimension.field, dimension.bucket);
    return {
      sql: `SELECT ${bucketSql} AS x, count() AS y FROM ${spec.baseTable}${where} GROUP BY x ORDER BY x ASC LIMIT ${limit}`,
      sourceTables: [...spec.sourceTables],
      dependencies,
      resultContract: "time_series",
      viewType: "line",
      displaySpec: { xLabel: dimension.field, yLabel: metricLabel(spec.metric.op, spec.metric.field) },
    };
  }

  if (dimension) {
    return {
      sql: `SELECT ${dimension.field} AS key, string::concat(${dimension.field} ?? '') AS label, count() AS value FROM ${spec.baseTable}${where} GROUP BY ${dimension.field} ORDER BY value DESC LIMIT ${limit}`,
      sourceTables: [...spec.sourceTables],
      dependencies,
      resultContract: "category_breakdown",
      viewType: "bar",
      displaySpec: { categoryLabel: dimension.field, metricLabel: metricLabel(spec.metric.op, spec.metric.field) },
    };
  }

  if (spec.metric.op === "count_distinct") {
    const field = spec.metric.field;
    if (!field) throw new ServiceError("VALIDATION_ERROR", "去重计数需要字段");
    return {
      sql: `SELECT count() AS value FROM (SELECT ${field} FROM ${spec.baseTable}${where} GROUP BY ${field}) LIMIT 1`,
      sourceTables: [...spec.sourceTables],
      dependencies,
      resultContract: "single_value",
      viewType: "kpi",
      displaySpec: { metricLabel: metricLabel(spec.metric.op, field) },
    };
  }

  if (spec.metric.op === "count") {
    return {
      sql: `SELECT count() AS value FROM ${spec.baseTable}${where} LIMIT 1`,
      sourceTables: [...spec.sourceTables],
      dependencies,
      resultContract: "single_value",
      viewType: "kpi",
      displaySpec: { metricLabel: "记录数" },
    };
  }

  const metricField = spec.metric.field!;
  const aggregateSql = compileAggregate(spec.metric.op, metricField);
  return {
    sql: `SELECT ${aggregateSql} AS value FROM ${spec.baseTable}${where} LIMIT 1`,
    sourceTables: [...spec.sourceTables],
    dependencies,
    resultContract: "single_value",
    viewType: "kpi",
    displaySpec: { metricLabel: metricLabel(spec.metric.op, metricField) },
  };
}

function compileWhere(
  filters: NonNullable<DashboardBuilderSpec["filters"]>,
): string {
  if (filters.length === 0) return "";

  const pieces = filters.flatMap((filter) => {
    switch (filter.op) {
      case "contains":
        if (filter.value === undefined || filter.value === null || filter.value === "") return [];
        return [`string::contains(string::lowercase(string::concat(${filter.field} ?? '')), ${sqlLiteral(String(filter.value).toLowerCase())})`];
      case "in":
        if (!Array.isArray(filter.value) || filter.value.length === 0) return [];
        return [`${filter.field} INSIDE ${sqlLiteral(filter.value)}`];
      case "is_null":
        return [`${filter.field} IS NULL`];
      case "is_not_null":
        return [`${filter.field} IS NOT NULL`];
      default: {
        const op = SIMPLE_OP_SQL[filter.op];
        if (!op || filter.value === undefined || filter.value === null || filter.value === "") return [];
        return [`${filter.field} ${op} ${sqlLiteral(filter.value)}`];
      }
    }
  });

  return pieces.length ? ` WHERE ${pieces.join(" AND ")}` : "";
}

function compileBucketExpr(field: string, bucket: "day" | "week" | "month" | "year"): string {
  switch (bucket) {
    case "year":
      return `string::slice(string::concat(${field} ?? ''), 0, 4)`;
    case "month":
      return `string::slice(string::concat(${field} ?? ''), 0, 7)`;
    case "week":
      return `string::slice(string::concat(${field} ?? ''), 0, 10)`;
    case "day":
    default:
      return `string::slice(string::concat(${field} ?? ''), 0, 10)`;
  }
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
    default:
      throw new ServiceError("VALIDATION_ERROR", `暂不支持的指标类型: ${op}`);
  }
}

function normalizeLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 20, 200));
}

function metricLabel(op: DashboardBuilderSpec["metric"]["op"], field?: string): string {
  switch (op) {
    case "count":
      return "记录数";
    case "count_distinct":
      return field ? `${field} 去重数` : "去重数";
    case "sum":
      return field ? `${field} 总和` : "总和";
    case "avg":
      return field ? `${field} 平均值` : "平均值";
    case "min":
      return field ? `${field} 最小值` : "最小值";
    case "max":
      return field ? `${field} 最大值` : "最大值";
  }
}

function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "NONE";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => sqlLiteral(item)).join(", ")}]`;
  return JSON.stringify(value);
}

function assertSafeIdentifier(value: string, message: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new ServiceError("VALIDATION_ERROR", `${message}: ${value}`);
  }
}

function assertSafeTable(value: string, message: string): void {
  if (!SAFE_TABLE.test(value)) {
    throw new ServiceError("VALIDATION_ERROR", `${message}: ${value}`);
  }
}
