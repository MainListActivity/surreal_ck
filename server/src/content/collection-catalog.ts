import { getRootDatabaseSession } from "../db/root-connection";

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0].filter((row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row));
}

/**
 * 活跃内容集合目录在 `_system.content_collection`。
 * 发布会话只签入内容库，读不到这张表，所以目录查询走 root。
 */
export async function activeContentCollectionKeys(): Promise<readonly string[]> {
  const db = await getRootDatabaseSession("_system");
  const result = await db.query(
    `SELECT collection_key FROM content_collection WHERE status = "active";`,
  );
  return rows(result).flatMap((row) => (typeof row.collection_key === "string" ? [row.collection_key] : []));
}
