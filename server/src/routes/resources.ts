/**
 * RR-012：资源检索保存确认的专用窄入口。
 *
 * 只有一个 endpoint —— POST /api/resources/research/save（SSE）。
 * 它存在的唯一理由是 embedding provider key 必须留在服务端；其余资源读写
 * 一律由浏览器直连 SurrealDB 完成，这里**不**提供通用资源 CRUD、
 * embedding enqueue、retry 或 reindex endpoint。
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { CallerSessionFactory } from "./ai-chat";
import { runResearchSave, type EmbeddingProvider } from "../resources/research-save";

export type ResourceRoutesDeps = {
  /** 用调用者 OIDC token authenticate 出 SurrealDB workspace 会话；保存写入全部走它。 */
  createCallerSession: CallerSessionFactory;
  /** 服务端持 key 的 embedding 生成器；未配置时有 profile 的 workspace 保存会以 error 事件失败。 */
  embeddingProvider?: EmbeddingProvider;
  requireUser?: () => MiddlewareHandler<AppBindings>;
};

export function createResourceRoutes(deps: ResourceRoutesDeps) {
  const requireUser = deps.requireUser ?? requireOidc;

  return new Hono<AppBindings>().post("/api/resources/research/save", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => null);

    let session;
    try {
      session = await deps.createCallerSession(c.var.user.rawToken);
    } catch (error) {
      throw new HttpError(403, "research-save-signin-failed", "Failed to sign in to workspace with caller token", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of runResearchSave(
          { session, embeddingProvider: deps.embeddingProvider },
          body,
        )) {
          await stream.writeSSE({ event: event.kind, data: JSON.stringify(event) });
        }
      } finally {
        await session.close().catch(() => {});
      }
    });
  });
}
