import {
  buildSurrealFieldSchema,
  coerceGridFieldValue,
  validateGridFieldValue,
} from "@surreal-ck/shared/field-schema";
import type {
  FilterClause,
  GridColumnDef,
  GridRow,
  RecordIdString,
  ViewParams,
} from "@surreal-ck/shared/rpc.types";
import type { SurrealConn, SurrealWriter } from "./surreal";

/** 写入结果：要么成功，要么带一条人类可读的错误（用于 UI 直接展示）。 */
export type SaveResult = { ok: true } | { ok: false; message: string };

export type CellPatch = {
  id?: RecordIdString;
  values: Record<string, unknown>;
};

export type BuiltQuery = {
  sql: string;
  bindings: Record<string, unknown>;
};

/** 一个 sheet 背后的真实业务表名 + 列定义；数据层只认这两样。 */
export type SheetRef = {
  tableName: string;
  columns: GridColumnDef[];
};

export type Pagination = {
  limit: number;
  start: number;
};

/** filter op → SurrealQL 比较运算符。is_null / is_not_null / in 走专门分支。 */
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
 * 把 sheet 的 {@link ViewParams} 编译成参数化 SurrealQL。
 *
 * - 表名走 `type::table($tb)`，永远绑定、永不内联——物理上只能产出 SELECT。
 * - 过滤/排序的列名必须出现在 `columns` 中，否则静默丢弃（防 SQL 注入：
 *   列标识不可参数化，所以只允许 schema 已知的列名进入 SQL 文本）。
 * - 过滤值一律走 `$f0` / `$f1` ... bindings，绝不拼进 SQL 字符串。
 * - **不**在此写任何 `WHERE user = $auth` 之类的权限过滤——PERMISSIONS 由
 *   DB 引擎兜底，查询只携带用户驱动的过滤项。
 */
export function buildSelect(
  tableName: string,
  view: ViewParams,
  columns: GridColumnDef[],
  page: Pagination,
): BuiltQuery {
  const known = new Set(columns.map((c) => c.key));
  const bindings: Record<string, unknown> = { tb: tableName };

  const conditions: string[] = [];
  for (const clause of view.filters ?? []) {
    if (!known.has(clause.key)) continue;
    const piece = filterToSql(clause, conditions.length, bindings);
    if (piece) conditions.push(piece);
  }

  let sql = "SELECT * FROM type::table($tb)";
  if (conditions.length) {
    const joiner = view.filterMode === "or" ? " OR " : " AND ";
    sql += ` WHERE ${conditions.join(joiner)}`;
  }

  const orderBy = (view.sorts ?? [])
    .filter((s) => known.has(s.key))
    .map((s) => `${s.key} ${s.direction === "desc" ? "DESC" : "ASC"}`);
  if (orderBy.length) sql += ` ORDER BY ${orderBy.join(", ")}`;

  sql += ` LIMIT ${page.limit} START ${page.start}`;
  return { sql, bindings };
}

/** entity 行上由 schema 维护、不属于业务列的系统字段，映射 GridRow 时剔除。 */
const SYSTEM_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

/**
 * 直连 SurrealDB 加载一个 sheet 的行：把 {@link buildSelect} 编译出的查询交给
 * 调用者会话执行，再把每条记录裁成 {@link GridRow}（只保留列定义里的业务字段）。
 * 跨 workspace 隔离由 db 边界保证；行级权限由表 PERMISSIONS 兜底——本函数不加任何鉴权过滤。
 */
export async function loadSheet(
  conn: SurrealConn,
  sheet: SheetRef,
  view: ViewParams,
  page: Pagination,
): Promise<GridRow[]> {
  const { sql, bindings } = buildSelect(sheet.tableName, view, sheet.columns, page);
  const records = await conn.query<Record<string, unknown>>(sql, bindings);
  const known = new Set(sheet.columns.map((c) => c.key));
  return records.map((record) => rowToGridRow(record, known));
}

/**
 * 直连写入若干单元格 patch：每条 patch 先按列定义 coerce + validate（复用
 * 前后端共享的 field-schema），全部通过后才下发——带 id 的走 `updateRecord`
 * (MERGE)，无 id 的走 `createRecord`。校验任一失败立即返回，绝不部分写入。
 * 权限由表 PERMISSIONS 兜底：普通成员若无 update 权限，写入会被引擎拒绝并抛错。
 */
export async function saveCells(
  conn: SurrealConn,
  sheet: SheetRef,
  patches: CellPatch[],
): Promise<SaveResult> {
  const columnByKey = new Map(sheet.columns.map((c) => [c.key, c]));

  const prepared: CellPatch[] = [];
  for (const patch of patches) {
    const coerced: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(patch.values)) {
      const column = columnByKey.get(key);
      if (!column) continue; // 未知列丢弃，schema 之外的字段不写
      const value = coerceGridFieldValue(raw, column);
      const errors = validateGridFieldValue(value, column);
      if (errors.length) {
        return { ok: false, message: `${key}：${errors.join("；")}` };
      }
      coerced[key] = value;
    }
    prepared.push({ ...(patch.id ? { id: patch.id } : {}), values: coerced });
  }

  try {
    await conn.transaction(async (tx) => {
      for (const patch of prepared) {
        await writePatch(tx, sheet.tableName, patch);
      }
    });
  } catch (err) {
    return { ok: false, message: describeWriteError(err) };
  }
  return { ok: true };
}

async function writePatch(
  tx: SurrealWriter,
  tableName: string,
  patch: CellPatch,
): Promise<void> {
  if (patch.id) {
    await tx.updateRecord(patch.id, patch.values);
  } else {
    await tx.createRecord(tableName, patch.values);
  }
}

/**
 * 直连删除若干行：每个 id 走 `deleteRecord`（DELETE by RecordId），放在一个事务里，
 * 任一删除失败整体回滚并返回 ok:false。权限由表 PERMISSIONS 兜底——普通成员若无 delete
 * 权限会被引擎拒绝，错误经 {@link describeWriteError} 翻译。空列表直接返回成功，不开事务。
 */
export async function deleteRows(
  conn: SurrealConn,
  ids: Array<RecordIdString | string>,
): Promise<SaveResult> {
  if (!ids.length) return { ok: true };
  try {
    await conn.transaction(async (tx) => {
      for (const id of ids) {
        await tx.deleteRecord(String(id));
      }
    });
  } catch (err) {
    return { ok: false, message: describeWriteError(err) };
  }
  return { ok: true };
}

/**
 * 管理员在浏览器直接给业务表加一列 = `DEFINE FIELD`（DDL）。
 * 字段的 type / ASSERT 由前后端共享的 {@link buildSurrealFieldSchema} 生成，
 * 保证浏览器侧建列与后端模板口径一致。
 *
 * DDL 能力由 DB 引擎层 access 类型卡死：admin(JWT) 放行，participant/employee
 * (RECORD) 会被引擎直接拒绝——**不在这里写 `if (!is_admin)` 守卫**，而是把引擎
 * 抛出的权限错误翻译成 UI 可读的中文提示。
 */
export async function defineField(
  conn: SurrealConn,
  tableName: string,
  column: GridColumnDef,
): Promise<SaveResult> {
  let schema: ReturnType<typeof buildSurrealFieldSchema>;
  try {
    schema = buildSurrealFieldSchema(column);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const ddl = `DEFINE FIELD ${schema.fieldName} ON TABLE ${tableName} TYPE ${schema.type}${schema.assert}`;
  try {
    await conn.query(ddl);
  } catch (err) {
    return { ok: false, message: describeWriteError(err) };
  }
  return { ok: true };
}

/** 把 SurrealDB 引擎错误翻译成 UI 可读提示；权限不足是普通成员尝试 DDL 的典型路径。 */
export function describeWriteError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/permission|not allowed|IAM/i.test(message)) {
    return "没有权限执行该操作（仅工作区管理员可修改表结构）";
  }
  return message;
}

export type LiveHandlers = {
  /** CREATE / UPDATE：把整行 upsert 进视图。 */
  onUpsert: (row: GridRow) => void;
  /** DELETE：从视图移除该 id。 */
  onRemove: (id: string) => void;
};

/**
 * 订阅 sheet 背后业务表的 LIVE 变更，直接驱动前端 `$state`——**后端不参与转发**。
 * CREATE / UPDATE 裁成 {@link GridRow} 交给 onUpsert，DELETE 把 id 交给 onRemove。
 * 在组件 onMount 调用、用返回的函数在 onDestroy 取消，防订阅泄漏。
 */
export async function subscribeLive(
  conn: SurrealConn,
  sheet: SheetRef,
  handlers: LiveHandlers,
): Promise<() => void> {
  const known = new Set(sheet.columns.map((c) => c.key));
  return conn.liveTable(sheet.tableName, (message) => {
    const id = String(message.value.id);
    if (message.action === "DELETE") {
      handlers.onRemove(id);
      return;
    }
    if (message.action === "CREATE" || message.action === "UPDATE") {
      handlers.onUpsert(rowToGridRow(message.value, known));
    }
  });
}

function rowToGridRow(record: Record<string, unknown>, known: Set<string>): GridRow {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    if (known.has(key)) values[key] = value;
  }
  return { id: String(record.id), values };
}

function filterToSql(
  clause: FilterClause,
  index: number,
  bindings: Record<string, unknown>,
): string | null {
  if (clause.op === "is_null") return `${clause.key} IS NULL`;
  if (clause.op === "is_not_null") return `${clause.key} IS NOT NULL`;

  const param = `f${index}`;
  if (clause.op === "in") {
    const arr = Array.isArray(clause.value) ? clause.value : [];
    if (arr.length === 0) return null;
    bindings[param] = arr;
    return `${clause.key} INSIDE $${param}`;
  }

  if (clause.value === undefined || clause.value === null || clause.value === "") return null;
  const comparator = COMPARATORS[clause.op];
  if (!comparator) return null;
  bindings[param] = clause.value;
  return `${clause.key} ${comparator} $${param}`;
}
