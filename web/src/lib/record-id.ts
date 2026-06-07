import { RecordId, StringRecordId } from "surrealdb";

/**
 * RecordId 边界转换：内存里 record 值以 string 形态在 RevoGrid / 网格层流转，
 * 但**交给 SurrealDB SDK 的那一刻**必须包成 RecordId，否则一个 `record` 字段
 * 与 string 比较永远不相等（`WHERE workbook = $wb`、`id INSIDE $ids` 静默查不到），
 * 写入 `record<table>` 字段也会因类型不符被引擎拒绝。
 *
 * 转换只发生在这一层 SDK 边界；内存对象 / sessionStorage / localStorage 仍存 string，
 * 存取时各自在自己的边界处理，不污染内存里的值类型。
 */

/** `table:id` 形态判定：冒号在中间、两侧都非空。与 reference-cache 同口径。 */
export function isLikelyRecordId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  return colon > 0 && colon < value.length - 1;
}

/** 把一个 RecordId 字符串包成 SDK 可识别的 {@link StringRecordId}（CBOR 序列化为真正的 record id）。 */
export function toRecordId(id: string): StringRecordId {
  return new StringRecordId(id);
}

/**
 * 绑定值规整：若是 RecordId 字符串则包成 StringRecordId，否则原样返回。
 * 用于把「可能是 record 也可能是普通标量」的绑定值安全地交给 SDK——
 * 仅识别 `table:id` 形态，普通字符串（如名字、状态）不受影响。
 */
export function asBindable(value: unknown): unknown {
  return isLikelyRecordId(value) ? toRecordId(value) : value;
}

/**
 * 把一个 record 字段的写入值规整为 SDK 形态：
 * - 单值：RecordId 字符串 → StringRecordId；
 * - 数组（多选引用）：逐项规整；
 * - null / 非 record 字符串：原样返回。
 */
export function toRecordFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (isLikelyRecordId(v) ? toRecordId(v) : v));
  return isLikelyRecordId(value) ? toRecordId(value) : value;
}

/**
 * 读边界规整：SDK 把 `record` 字段读回成 {@link RecordId} 实例，但网格 / 引用 UI / 缓存
 * 全部以 string 形态在内存流转（`typeof v === "string"` 守卫、`entries[id]` 索引）。
 * 这里把 RecordId 实例（及其数组）规整回 `table:id` 字符串，使读回的值与内存模型一致；
 * 非 record 值原样返回。
 */
export function recordValueToString(value: unknown): unknown {
  if (value instanceof RecordId) return value.toString();
  if (value instanceof StringRecordId) return value.toString();
  if (Array.isArray(value)) return value.map(recordValueToString);
  return value;
}
