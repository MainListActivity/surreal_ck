import type { FilterClause, GridColumnDef, ViewParams } from "@surreal-ck/shared/rpc.types";
import { omitNullishSurrealFields } from "@surreal-ck/shared/surreal-values";
import { asBindable, toRecordFieldValue } from "./record-id";

/** UI 可直接消费的写入结果。业务写操作只能由 DataTableRuntime 产生。 */
export type SaveResult = { ok: true } | { ok: false; message: string };

export type BuiltQuery = {
  sql: string;
  bindings: Record<string, unknown>;
};

export type Pagination = {
  limit: number;
  start: number;
};

const COMPARATORS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "CONTAINS",
  not_contains: "CONTAINSNOT",
};

/**
 * 把视图参数编译成参数化 SELECT。此处是无副作用的查询编译器，不持有数据表生命周期。
 * 表名和值均绑定；无法参数化的字段标识只允许来自当前 schema。
 */
export function buildSelect(
  tableName: string,
  view: ViewParams,
  columns: GridColumnDef[],
  page: Pagination,
): BuiltQuery {
  const known = new Set(columns.map((column) => column.key));
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  const bindings: Record<string, unknown> = { tb: tableName };
  const conditions: string[] = [];

  for (const clause of view.filters ?? []) {
    if (!known.has(clause.key)) continue;
    const piece = filterToSql(clause, conditions.length, bindings, columnByKey.get(clause.key));
    if (piece) conditions.push(piece);
  }

  let sql = "SELECT * FROM type::table($tb)";
  if (conditions.length) {
    sql += ` WHERE ${conditions.join(view.filterMode === "or" ? " OR " : " AND ")}`;
  }

  const orderBy = (view.sorts ?? [])
    .filter((sort) => known.has(sort.key))
    .map((sort) => `${sort.key} ${sort.direction === "desc" ? "DESC" : "ASC"}`);
  if (orderBy.length) sql += ` ORDER BY ${orderBy.join(", ")}`;

  sql += ` LIMIT ${page.limit} START ${page.start}`;
  return { sql, bindings };
}

/** 在 SDK 边界把 reference 值转换为 RecordId；其余字段保持领域值。 */
export function wrapRecordField(value: unknown, column: GridColumnDef): unknown {
  return column.fieldType === "reference" ? toRecordFieldValue(value) : value;
}

/**
 * 纯编解码辅助：DataTableRuntime 在 create 边界包装 record 字段并省略 NONE 字段。
 * 它不执行查询或写入，因此不会形成绕过 runtime 的第二入口。
 */
export function prepareRecordFields(
  values: Record<string, unknown>,
  columns: GridColumnDef[],
): Record<string, unknown> {
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const column = columnByKey.get(key);
    out[key] = column ? wrapRecordField(value, column) : value;
  }
  return omitNullishSurrealFields(out);
}

/** 把引擎错误归一成 UI 可读消息。 */
export function describeWriteError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/permission|not allowed|IAM/i.test(message)) {
    return "没有权限执行该操作（仅工作区管理员可修改表结构）";
  }
  return message;
}

function filterToSql(
  clause: FilterClause,
  index: number,
  bindings: Record<string, unknown>,
  column?: GridColumnDef,
): string | null {
  if (clause.op === "is_null") return `${clause.key} IS NULL`;
  if (clause.op === "is_not_null") return `${clause.key} IS NOT NULL`;

  const isReference = column?.fieldType === "reference";
  const param = `f${index}`;
  if (clause.op === "in") {
    const values = Array.isArray(clause.value) ? clause.value : [];
    if (!values.length) return null;
    bindings[param] = isReference ? values.map(asBindable) : values;
    return `${clause.key} INSIDE $${param}`;
  }

  if (clause.value === undefined || clause.value === null || clause.value === "") return null;
  const comparator = COMPARATORS[clause.op];
  if (!comparator) return null;
  bindings[param] = isReference ? asBindable(clause.value) : clause.value;
  return `${clause.key} ${comparator} $${param}`;
}
