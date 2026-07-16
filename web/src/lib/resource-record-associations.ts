import { recordValueToString, toRecordId } from "./record-id";
import type { RelatedResourceSummary } from "./research-panel";
import type { SurrealConn } from "./surreal";

type RelatedResourceRow = {
  link_id: unknown;
  resource_id: unknown;
  title: unknown;
  summary: unknown;
  source_url?: unknown;
};

/** 用当前浏览器 workspace session 建立资源到业务记录的关系。 */
export async function linkResourceToRecord(
  conn: SurrealConn,
  resourceId: string,
  recordId: string,
): Promise<void> {
  const links = await conn.query<{ id: unknown }>(
    "RELATE $resource->resource_record_link->$record;",
    { resource: toRecordId(resourceId), record: toRecordId(recordId) },
  );
  if (!links.length) {
    throw new Error("资源关联失败：资源、记录不存在或当前用户无权操作。");
  }
}

/** 从当前记录反向遍历资源关系；资源删除事件会清边，仍忽略不完整的旧数据。 */
export async function listResourcesForRecord(
  conn: SurrealConn,
  recordId: string,
): Promise<RelatedResourceSummary[]> {
  const rows = await conn.query<RelatedResourceRow>(
    `SELECT
      id AS link_id,
      in.id AS resource_id,
      in.title AS title,
      in.summary AS summary,
      in.source_url AS source_url,
      created_at
    FROM $record<-resource_record_link
    ORDER BY created_at DESC;`,
    { record: toRecordId(recordId) },
  );

  return rows.flatMap((row) => {
    const linkId = recordValueToString(row.link_id);
    const resourceId = recordValueToString(row.resource_id);
    if (typeof linkId !== "string" || typeof resourceId !== "string") return [];
    return [{
      linkId,
      resourceId,
      title: String(row.title ?? resourceId),
      summary: String(row.summary ?? ""),
      sourceUrl: typeof row.source_url === "string" ? row.source_url : undefined,
    }];
  });
}

/** 只删除关系记录；资源主记录及业务记录都保持不变。 */
export async function unlinkResourceFromRecord(conn: SurrealConn, linkId: string): Promise<void> {
  const removed = await conn.query<unknown>("DELETE ONLY $link RETURN BEFORE;", {
    link: toRecordId(linkId),
  });
  if (!removed.length) {
    throw new Error("解除资源关联失败：关联不存在或当前用户无权操作。");
  }
}
