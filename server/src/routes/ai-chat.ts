import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import type { AiContextSnapshot, ResumeDecision } from "@surreal-ck/shared";
import { ResumeAiWorkflowRequestSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type { RunRegistry } from "../ai/run-registry";

/** 用调用者 OIDC token 在 SurrealDB 上 authenticate 出一条会话（admin / participant access）。失败即抛。 */
export type CallerSessionFactory = (rawToken: string) => Promise<Surreal>;

/** 把 Mastra router workflow 的启动 / 续跑封装成可注入的服务，路由本体不直接依赖 Mastra 装配。 */
export type AiChatService = {
  /** 后台启动一个 router workflow run；应立即返回，workflow 在后台继续跑（事件经 RunBus 推送）。 */
  startChat(input: {
    runId: string;
    message: string;
    userContext?: AiContextSnapshot;
    surrealSession: Surreal;
  }): Promise<void>;
  /** 后台续跑一个已 suspend 的 run：用（可能已刷新的）新 session 提交 decision；workflow state 不持有 session。 */
  resumeChat(input: {
    runId: string;
    decision: ResumeDecision;
    surrealSession: Surreal;
  }): Promise<void>;
};

export type AiChatRoutesDeps = {
  service: AiChatService;
  createCallerSession: CallerSessionFactory;
  registry: RunRegistry;
  requireUser?: () => MiddlewareHandler<AppBindings>;
};

export function createAiChatRoutes(deps: AiChatRoutesDeps): Hono<AppBindings> {
  const requireUser = deps.requireUser ?? requireOidc;
  const routes = new Hono<AppBindings>();

  /** token 通过了 OIDC 校验，但 SurrealDB access AUTHENTICATE 拒绝（db 不存在 / scope 不匹配）→ 403。 */
  async function signIn(rawToken: string): Promise<Surreal> {
    try {
      return await deps.createCallerSession(rawToken);
    } catch (error) {
      throw new HttpError(403, "chat-signin-failed", "Failed to sign in to workspace with caller token", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  routes.post("/api/chat", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const user = c.var.user;

    // ── resume 路径 ──
    if (body?.resume !== undefined && body?.resume !== null) {
      const parsed = ResumeAiWorkflowRequestSchema.safeParse(body.resume);
      if (!parsed.success) {
        throw new HttpError(400, "chat-resume-invalid", "resume payload is invalid", parsed.error.flatten());
      }
      const { runId, decision } = parsed.data;

      const record = deps.registry.get(runId);
      if (!record || record.ownerSubject !== user.subject) {
        // 找不到 / 非本人持有 → 不泄漏 run 是否存在，统一 403。
        throw new HttpError(403, "chat-run-forbidden", "Run is not owned by caller");
      }

      // resume 用新 session（OIDC token 可能已刷新；workflow state 不持有 session 引用）。
      const session = await signIn(user.rawToken);
      // 刷新 streamToken / TTL，客户端据此重连 WS 拿后续事件。
      const { streamToken } = deps.registry.register({ runId, ownerSubject: user.subject });

      await deps.service.resumeChat({ runId, decision: decision as ResumeDecision, surrealSession: session });

      return c.json({ runId, streamUrl: `/api/chat/stream?runId=${runId}`, streamToken });
    }

    // ── 新 run 路径 ──
    const message = typeof body?.message === "string" ? body.message : undefined;
    if (!message) {
      throw new HttpError(400, "chat-message-required", "message is required");
    }
    const userContext = body?.contextSnapshot as AiContextSnapshot | undefined;

    const session = await signIn(user.rawToken);

    const runId = crypto.randomUUID();
    const { streamToken } = deps.registry.register({ runId, ownerSubject: user.subject });

    await deps.service.startChat({ runId, message, userContext, surrealSession: session });

    return c.json({ runId, streamUrl: `/api/chat/stream?runId=${runId}`, streamToken });
  });

  return routes;
}
