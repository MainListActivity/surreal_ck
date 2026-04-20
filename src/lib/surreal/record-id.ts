/**
 * RecordId / DateTime 工具（local-first webview 版本）
 *
 * webview 端所有 ID 均为纯字符串（"table:id" 格式），
 * 实际的 RecordId/DateTime 对象转换发生在 Bun 主进程侧（@surrealdb/node）。
 */

/**
 * 将 "table:id" 格式字符串验证并原样返回。
 * 供需要显式标注"这是一个 recordId"的地方使用。
 */
export function toRecordId(value: string): string {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`无效的 record id（缺少冒号）: ${value}`);
  }
  const table = value.slice(0, colonIndex);
  const id = value.slice(colonIndex + 1);
  if (!table || !id) {
    throw new Error(`无效的 record id: ${value}`);
  }
  return value;
}

/**
 * 解析 recordId 为 table 和 id 两部分
 */
export function parseRecordId(recordId: string): { table: string; id: string } {
  const colonIdx = recordId.indexOf(":");
  if (colonIdx === -1) throw new Error(`无效的 recordId: ${recordId}`);
  return {
    table: recordId.slice(0, colonIdx),
    id: recordId.slice(colonIdx + 1),
  };
}

/**
 * 将 Date 或 ISO 字符串转为 ISO 8601 字符串（IPC 传输格式）
 */
export function toDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString();
}

/** 返回当前时间的 ISO 字符串 */
export function nowDateTime(): string {
  return new Date().toISOString();
}
