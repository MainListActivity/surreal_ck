import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { LegalRetrievalRequestSchema } from "@surreal-ck/shared";
import type { ContentResearchSessionFactory } from "../research/window";
import type { EmbeddingProvider } from "../resources/research-save";
import { retrievePlatformCandidates } from "../research/platform-retrieval";

export function createLegalContentRoutes(input: Readonly<{
  requireUser?: () => MiddlewareHandler<AppBindings>;
  openContentSession?: ContentResearchSessionFactory;
  embeddingProvider?: EmbeddingProvider;
}>) {
  const requireUser = input.requireUser ?? requireOidc;

  return new Hono<AppBindings>().post("/api/legal/search", requireUser(), async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HttpError(400, "invalid_request", "请求体必须是合法 JSON");
    });
    const parsed = LegalRetrievalRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "检索请求或筛选条件无效");
    if (!input.openContentSession) throw new HttpError(503, "content_authorization_unavailable", "平台内容授权服务尚未就绪");
    const window = await input.openContentSession(c.var.user);
    c.header("Cache-Control", "no-store");
    if (window.kind === "empty") return c.json({
      items: [], capability: "keyword", notice: "当前授权范围内暂无内容。", rankingVersion: "legal-rrf-v1", indexVersion: null,
    });
    if (window.kind !== "ready") throw new HttpError(503, "content_authorization_unavailable", "内容授权暂不可用，请重新验证");
    try {
      if (window.leaseEndSeconds <= Date.now() / 1000) throw new HttpError(403, "content_session_expired", "内容会话已到期");
      const result = await retrievePlatformCandidates({ session: window.session, request: parsed.data, embeddingProvider: input.embeddingProvider });
      if (window.leaseEndSeconds <= Date.now() / 1000) throw new HttpError(403, "content_session_expired", "内容会话已到期");
      return c.json(result);
    } finally { await window.close(); }
  });
}
