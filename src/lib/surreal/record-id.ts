import { RecordId } from 'surrealdb';

/**
 * 将 "table:id" 格式的字符串转换为 SurrealDB RecordId 对象。
 * 所有向数据库传递 record id 参数时必须使用此函数包裹。
 */
export function toRecordId(value: string): RecordId {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid record id (missing colon): ${value}`);
  }
  const table = value.slice(0, colonIndex);
  const id = value.slice(colonIndex + 1);
  if (!table || !id) {
    throw new Error(`Invalid record id: ${value}`);
  }
  return new RecordId(table, id);
}
