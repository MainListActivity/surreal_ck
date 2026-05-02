/**
 * SurrealDB type mapping:
 * - JS null   -> Surreal NULL（对 option<T> / T | NONE 会类型报错）
 * - JS undefined -> Surreal NONE / 字段移除
 *
 * 因此：
 * - CREATE / CONTENT：未填写字段直接省略
 * - UPDATE / MERGE / SET：显式清空字段时把 null 转成 undefined
 */

export function omitNullishSurrealFields(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== undefined),
  );
}

export function mapNullToSurrealNone<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

export function mapNullsToSurrealNone(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? undefined : value]),
  );
}
