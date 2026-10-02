import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { LegalRetrievalRequestSchema, citationStatusRequestSchema } from "@surreal-ck/shared";
import type { ContentResearchSessionFactory } from "../research/window";
import type { EmbeddingProvider } from "../resources/research-save";
import { retrievePlatformCandidates } from "../research/platform-retrieval";
import { createCitationStatusHandler } from "../research/citation-status";

export function createLegalContentRoutes(input: Readonly<{
  requireUser?: () => MiddlewareHandler<AppBindings>;
  openContentSession?: ContentResearchSessionFactory;
  embeddingProvider?: EmbeddingProvider;
  /** LCA09：历史引用按当前权限展示；测试注入替代真实控制面读取。 */
  citationStatus?: ReturnType<typeof createCitationStatusHandler>;
}>) {
  const requireUser = input.requireUser ?? requireOidc;
  const citationStatus = input.citationStatus ?? createCitationStatusHandler();

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
    // LCA14：开关关闭是确定性暂停（403+明示），区别于授权链路的暂态不可用（503）。
    if (window.kind === "unavailable" && window.reason === "feature_suspended") {
      throw new HttpError(403, "legal-content-suspended", "法律内容访问已由平台运营暂停");
    }
    if (window.kind !== "ready") throw new HttpError(503, "content_authorization_unavailable", "内容授权暂不可用，请重新验证");
    try {
      if (window.leaseEndSeconds <= Date.now() / 1000) throw new HttpError(403, "content_session_expired", "内容会话已到期");
      const result = await retrievePlatformCandidates({ session: window.session, request: parsed.data, embeddingProvider: input.embeddingProvider });
      if (window.leaseEndSeconds <= Date.now() / 1000) throw new HttpError(403, "content_session_expired", "内容会话已到期");
      return c.json(result);
    } finally { await window.close(); }
  }).post("/api/legal/citation-status", requireUser(), async (c) => {
    // LCA09：历史报告保留原文；引用逐项按当前权限返回展示状态（只回状态，不回内容）。
    const body: unknown = await c.req.json().catch(() => {
      throw new HttpError(400, "invalid_request", "请求体必须是合法 JSON");
    });
    const parsed = citationStatusRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "引用状态请求不符合契约结构");
    let result;
    try {
      result = await citationStatus(c.var.user, parsed.data);
    } catch {
      throw new HttpError(503, "citation_status_unavailable", "引用权限核验暂不可用，请稍后重试");
    }
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
}
