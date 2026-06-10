/**
 * research_session 的浏览器直连操作（RR-012）。
 *
 * 业务写默认前端直连：完成检索 = 把 open 会话置 completed。
 * 可见性与可写性由 schema PERMISSIONS（创建者或管理员）兜底，这里不重复过滤。
 */
import type { SurrealConn } from "./surreal";
import { toRecordId } from "./record-id";

/** 幂等：resume 失败后用户重试「完成检索」时，重复置 completed 不报错。 */
export async function completeResearchSession(conn: SurrealConn, sessionId: string): Promise<void> {
  const results = await conn.query<unknown>(
    "UPDATE ONLY $session SET status = 'completed', completed_at = completed_at ?? time::now();",
    { session: toRecordId(sessionId) },
  );
  const updated = Array.isArray(results) ? results[0] : results;
  if (!updated) {
    throw new Error("检索会话不存在或无权访问，无法完成。");
  }
}
