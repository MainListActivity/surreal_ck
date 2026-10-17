/**
 * 提案确认写的事务内执行体（服务端受栅栏写端点的一半）。
 *
 * 与浏览器直连写路径同一口径：读 sheet.column_defs 得到列定义 → 归一字段名 →
 * 类型强制 → 字段校验 → 只写变化字段 → MERGE / CREATE。写发生在调用者会话的
 * 事务里，PERMISSIONS 由表定义兜底；权限拒绝即整笔回滚（含栅栏消费）。
 *
 * 编解码口径来自 shared/proposal-write + shared/field-schema，与 web 的
 * data-table-runtime / editor-store 同一份实现，不存在「服务端一套、前端一套」。
 */

import type { SurrealTransaction } from "surrealdb";
import { StringRecordId, Table } from "surrealdb";
import {
  changedProposalValues,
  coerceGridFieldValue,
  mapNullsToSurrealNone,
  normalizeProposalValues,
  omitNullishSurrealFields,
  storedColumnToDTO,
  unknownProposalKeys,
  validateGridFieldValue,
  type RecordWriteProposal,
  type RowPatchProposal,
} from "@surreal-ck/shared";
import { HttpError } from "../http-error";

export type ProposalWriteTarget = {
  sheetId: string;
  recordId?: string;
  operation: "patch" | "create";
};

export type ProposalWriteOutcome = {
  /** 实际写入的字段（已归一到存储 key 并去掉未变化项）。空对象表示无需写。 */
  written: Record<string, unknown>;
  created: boolean;
  createdRecordId?: string;
};

type SheetRow = { id?: unknown; table_name?: unknown; column_defs?: unknown };
type RecordRow = Record<string, unknown>;

/**
 * 解 SDK 查询结果的第一语句行集。
 *
 * 公司 fork 的 surrealdb SDK 对 `SELECT ... FROM ONLY <record>` 返回裸对象形状
 * （results[0] = {row} 或 null），常规 `SELECT` / `CREATE` 仍是 [[rows]]。
 * 只认数组会把 ONLY 读路径恒解成 []，loadSheet 误报 403、读记录误报 404。
 * 先例：secret-store rows()（182f0e8e）。
 */
function firstRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  const first = result[0];
  if (Array.isArray(first)) return first as T[];
  return first !== null && typeof first === "object" ? [first as T] : [];
}

function isLikelyRecordId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  return colon > 0 && colon < value.length - 1;
}

/** reference 列的值在 SDK 边界必须包成 RecordId，否则写 record 字段被引擎拒绝。 */
function toRecordFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (isLikelyRecordId(item) ? new StringRecordId(item) : item));
  return isLikelyRecordId(value) ? new StringRecordId(value) : value;
}

function wrapRecordField(value: unknown, fieldType: string): unknown {
  return fieldType === "reference" ? toRecordFieldValue(value) : value;
}

/** 目标 sheet 的物理表名与列定义；不可见/不存在即 403，不泄露他人 sheet。 */
async function loadSheet(
  tx: SurrealTransaction,
  sheetId: string,
): Promise<{ tableName: string; columns: ReturnType<typeof storedColumnToDTO>[] }> {
  if (!isLikelyRecordId(sheetId)) {
    throw new HttpError(400, "chat-write-invalid-target", "提案对应的数据表标识无效。");
  }
  const rows = firstRows<SheetRow>(await tx.query(
    "SELECT table_name, column_defs FROM ONLY $sheet;",
    { sheet: new StringRecordId(sheetId) },
  ));
  const row = rows[0];
  const tableName = typeof row?.table_name === "string" ? row.table_name : "";
  if (!row || !tableName) {
    throw new HttpError(403, "chat-write-target-unavailable", "提案对应的数据表当前不可见，请刷新页面后重试。");
  }
  const columns = Array.isArray(row.column_defs)
    ? row.column_defs.map((def) => storedColumnToDTO(def as never))
    : [];
  return { tableName, columns };
}

export type ProposalWriteRequest = {
  target: ProposalWriteTarget;
  /** 用户实际勾选的字段（未勾选的绝不写入）。 */
  values: Record<string, unknown>;
};

/**
 * 在已开启的调用者事务里执行提案写。
 *
 * 语义与前端直连写一致：
 * - 未知列、label 歧义、归一撞键、字段校验失败 → 抛 HttpError，事务回滚，
 *   栅栏消费一并撤销（下次确认仍是 pending，可重试）。
 * - 无字段变化 → 零写入并返回空 written（栅栏照常消费，run 正常推进）。
 */
export async function writeProposalValues(
  tx: SurrealTransaction,
  request: ProposalWriteRequest,
): Promise<ProposalWriteOutcome> {
  const { target, values } = request;
  const { tableName, columns } = await loadSheet(tx, target.sheetId);

  const normalized = normalizeProposalValues(values, columns);
  if (!normalized.ok) {
    throw new HttpError(422, "chat-write-field-collision", normalized.message);
  }
  const coerced = Object.fromEntries(Object.entries(normalized.values).map(([key, value]) => {
    const column = columns.find((item) => item.key === key);
    return [key, coerceGridFieldValue(value, column)];
  }));
  const unknown = unknownProposalKeys(coerced, columns);
  if (unknown.length) {
    throw new HttpError(422, "chat-write-unknown-field", `记录包含未知字段：${unknown.join(", ")}`);
  }
  const fieldErrors: Record<string, string[]> = {};
  for (const column of columns) {
    if (!(column.key in coerced)) continue;
    const errors = validateGridFieldValue(coerced[column.key], column);
    if (errors.length) fieldErrors[column.key] = errors;
  }
  if (Object.keys(fieldErrors).length) {
    throw new HttpError(422, "chat-write-validation-failed", "记录未通过字段校验", fieldErrors);
  }

  const prepared = Object.fromEntries(Object.entries(coerced).map(([key, value]) => {
    const column = columns.find((item) => item.key === key);
    return [key, wrapRecordField(value, column?.fieldType ?? "text")];
  }));

  if (target.operation === "create") {
    const rows = firstRows<RecordRow>(await tx.query(
      "CREATE type::table($table) CONTENT $content RETURN AFTER;",
      { table: new Table(tableName), content: omitNullishSurrealFields(prepared) },
    ));
    const created = rows[0];
    return {
      written: prepared,
      created: true,
      ...(created?.id ? { createdRecordId: String(created.id) } : {}),
    };
  }

  if (!target.recordId || !isLikelyRecordId(target.recordId)) {
    throw new HttpError(400, "chat-write-invalid-target", "更新提案缺少有效的目标记录。");
  }
  const recordId = new StringRecordId(target.recordId);
  const existing = firstRows<RecordRow>(await tx.query("SELECT * FROM ONLY $record;", { record: recordId }));
  if (!existing[0]) {
    throw new HttpError(404, "chat-write-record-missing", `记录不存在：${target.recordId}`);
  }

  // 只写真正变化的字段：其余列不动（与手工编辑的最小 patch 同口径）。
  const changed = changedProposalValues(existing[0], prepared);
  if (Object.keys(changed).length === 0) {
    return { written: {}, created: false };
  }
  await tx.query("UPDATE $record MERGE $patch;", { record: recordId, patch: mapNullsToSurrealNone(changed) });
  return { written: changed, created: false };
}

/** 请求体解析：row-patch / record-write 两类提案的 sheetId·recordId·operation 归一。 */
export function proposalWriteTargetFrom(
  proposal: RowPatchProposal | RecordWriteProposal,
): ProposalWriteTarget {
  if (proposal.type === "row-patch-proposal") {
    return { sheetId: proposal.sheetId, recordId: proposal.recordId, operation: "patch" };
  }
  return {
    sheetId: proposal.sheetId,
    ...(proposal.recordId ? { recordId: proposal.recordId } : {}),
    operation: proposal.operation === "create" ? "create" : "patch",
  };
}
