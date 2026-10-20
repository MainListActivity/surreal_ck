/**
 * LCA13 发布门禁撤销计数的纯解析（无 I/O，供 grant-revocation-check-cli.ts 与单元测试共用）。
 *
 * 失败关闭：结果形状偏离任何已知形式即抛错，调用方以退出码 2 拒绝激活，绝不回落为 0。
 * 「撤销表未定义」只由 INFO FOR DB 的 tables 映射判定（与 migrate-legacy 的 assertLegacyContentMigrated 同一模式），
 * 不依据错误文本：错误文本也可能来自缺失的 namespace/database，那是无法证明的状态。
 */

export const GRANT_REVOCATION_TABLE = "content_grant_revocation";

/** `INFO FOR DB` 的 tables 映射中是否定义了撤销表。tables 缺失或形状异常即抛错。 */
export function revocationTableDefined(infoResult: unknown): boolean {
  const metadata = Array.isArray(infoResult) ? infoResult[0] : undefined;
  const tables = metadata && typeof metadata === "object" ? Reflect.get(metadata, "tables") : undefined;
  if (!tables || typeof tables !== "object") {
    throw new Error("cannot inspect _system tables (INFO FOR DB has no tables map)");
  }
  return Object.hasOwn(tables, GRANT_REVOCATION_TABLE);
}

/**
 * `SELECT count() AS count FROM content_grant_revocation GROUP ALL;` 的计数。
 * 无行（表已定义但为空）返回 0；否则只接受恰好一行，且 count 为安全非负整数。
 */
export function parseRevocationCount(queryResult: unknown): number {
  const statement = Array.isArray(queryResult) ? queryResult[0] : undefined;
  if (!Array.isArray(statement)) {
    throw new Error("revocation count query returned no statement result");
  }
  if (statement.length === 0) return 0;
  if (statement.length !== 1) {
    throw new Error("revocation count query returned more than one row");
  }
  const count = statement[0] && typeof statement[0] === "object" ? Reflect.get(statement[0], "count") : undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("revocation count is not a non-negative safe integer");
  }
  return count;
}
