import { Hono } from "hono";
import { validator } from "hono/validator";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import type { AiContextSnapshot, ResumeDecision } from "@surreal-ck/shared";
import {
  AI_CHAT_ACTION_KEY,
  AiContextSnapshotSchema,
  ResumeAiWorkflowRequestSchema,
} from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { AiAllowanceError } from "../ai-allowance/service";
import type { ContentResearchSessionFactory } from "../research/window";
import type { OpenContentResearchSession } from "../../ai/mastra/workflows/router-workflow";
import { claimResumeWindow } from "../research/resume-window";
import type { RunRegistry } from "../ai/run-registry";

/** 用调用者 OIDC token 在 SurrealDB 上 authenticate 出一条会话（admin / participant access）。失败即抛。 */
export type CallerSessionFactory = (rawToken: string) => Promise<Surreal>;

/** 把 Mastra router workflow 的启动 / 续跑封装成可注入的服务，路由本体不直接依赖 Mastra 装配。 */
/** run 终态：success 交付可用结果；suspended 等决策；failed/cancelled 未交付。 */
export type RunTerminalOutcome = "success" | "suspended" | "cancelled" | "failed";

export type AiChatService = {
  /** 后台启动一个 router workflow run；应立即返回，workflow 在后台继续跑（事件经 RunBus 推送）。 */
  startChat(input: {
    runId: string;
    message: string;
    userContext?: AiContextSnapshot;
    surrealSession: Surreal;
    /** 调用者 OIDC subject；stream 授权和 Mastra 上下文识别用，DB 归因走 caller session 的 $auth。 */
    ownerSubject: string;
    /** composer 显式提交模式；resource-search 确定性进入资源检索子 agent。 */
    composerMode?: "chat" | "resource-search";
    /** LCA06：调用者 content_reader 窗口工厂（路由层用调用者 token 构造；模型不可自选上下文）。 */
    openContentSession?: OpenContentResearchSession;
    /** run 到达终态时回调一次（suspended 也回调——门禁据此决定释放还是保留预留）。 */
    onTerminal?: (outcome: RunTerminalOutcome) => void | Promise<void>;
  }): Promise<void>;
  /** 后台续跑一个已 suspend 的 run：用（可能已刷新的）新 session 提交 decision；workflow state 不持有 session。 */
  resumeChat(input: {
    runId: string;
    decision: ResumeDecision;
    surrealSession: Surreal;
    /** 调用者 OIDC subject；stream 授权和 Mastra 上下文识别用，DB 归因走 caller session 的 $auth。 */
    ownerSubject: string;
    openContentSession?: OpenContentResearchSession;
    onTerminal?: (outcome: RunTerminalOutcome) => void | Promise<void>;
  }): Promise<void>;
};

/** AI 额度门禁的窄接口：reserve 失败抛 AiAllowanceError；finishByRun 幂等收口。 */
export type AiAllowanceGate = {
  reserve(input: {
    db: string;
    actor: StringRecordId;
    channel: "interactive" | "employee" | "api_mcp" | "batch";
    actionKey: string;
    idempotencyKey: string;
    runId: string;
  }): Promise<{ metered: boolean }>;
  resume?(input: { db: string; actor: StringRecordId; runId: string; actionKey: string; idempotencyKey: string }): Promise<{ metered: boolean }>;
  finishByRun(input: { db: string; runId: string; outcome: "success" | "failure" | "cancelled" }): Promise<void>;
};

export type AiChatRoutesDeps = {
  service: AiChatService;
  createCallerSession: CallerSessionFactory;
  registry: RunRegistry;
  /** LCA05 共享 AI 额度门禁；未注入时 /api/chat 不计量（向后兼容）。 */
  allowance?: AiAllowanceGate;
  /** LCA06：为调用者开设 content_reader 研究窗口的工厂；注入后 AI 研究可联合平台授权语料。 */
  createContentResearchSession?: ContentResearchSessionFactory;
  /**
   * LCA-14：AI 能力灰度开关。返回 false 时拒绝新 run 与 resume
   * （503 ai-capability-disabled）；已运行中的 run 不追溯。
   * 未注入时默认放行（开关行缺失同语义）。
   */
  checkAiCapability?: (workspaceDb: string) => Promise<boolean>;
  requireUser?: () => MiddlewareHandler<AppBindings>;
};

async function closeCallerSessionQuietly(session: Surreal): Promise<void> {
  const close = (session as unknown as { close?: () => Promise<unknown> | unknown }).close;
  if (typeof close !== "function") return;
  try {
    await close.call(session);
  } catch (error) {
    console.warn("[ai-chat] failed to close caller session after startup failure", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const resumeDecisionJson = validator("json", (value: { decision?: unknown }, c) => {
  const parsed = ResumeAiWorkflowRequestSchema.safeParse({
    runId: c.req.param("runId"),
    decision: value?.decision,
  });
  if (!parsed.success) {
    throw new HttpError(400, "chat-resume-invalid", "resume payload is invalid", parsed.error.flatten());
  }
  return {
    runId: parsed.data.runId,
    decision: parsed.data.decision as ResumeDecision,
  };
});

export function createAiChatRoutes(deps: AiChatRoutesDeps) {
  const requireUser = deps.requireUser ?? requireOidc;

  /**
   * token 的 `db` scope claim = 目标 workspace database 名；缺失时返回 undefined。
   * 真实调用方无 db claim 就无法 signin 到 ws db（在门禁之前已 403），
   * 所以缺 claim 时跳过计量是安全的，不构成绕过。
   */
  function workspaceDb(user: AppBindings["Variables"]["user"]): string | undefined {
    const db = (user.raw as Record<string, unknown> | undefined)?.db;
    return typeof db === "string" && db.length > 0 ? db : undefined;
  }

  /** 调用者会话 → user record id（admin JWT 经 $token.sub 反查；participant/employee 即 $auth）。 */
  async function callerUserId(session: Surreal): Promise<StringRecordId> {
    let result: unknown;
    try {
      result = await session.query("RETURN fn::current_user()");
    } catch (error) {
      throw new HttpError(503, "chat-actor-unavailable", "cannot reach workspace database; retry later", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const statement = Array.isArray(result) ? result[0] : result;
    const value = Array.isArray(statement) ? statement[0] : statement;
    if (value == null) {
      throw new HttpError(403, "chat-actor-unresolved", "cannot resolve caller user record");
    }
    return new StringRecordId(String(value));
  }

  function allowanceFail(error: unknown): never {
    if (!(error instanceof AiAllowanceError)) throw error;
    const status = error.code === "ai-allowance-insufficient" ? 402
      : error.code === "ai-allowance-unavailable" ? 503
      : 403;
    throw new HttpError(status, error.code, error.message, error.details);
  }

  /** 计量过的 run：终态回调把预留结算/释放；suspended 不收口（预留跨 resume 保留到 deadline）。 */
  function meteredTerminalHandler(db: string, runId: string): (outcome: RunTerminalOutcome) => void {
    return (outcome) => {
      if (outcome === "suspended") return;
      void deps.allowance
        ?.finishByRun({
          db,
          runId,
          outcome: outcome === "success" ? "success" : outcome === "cancelled" ? "cancelled" : "failure",
        })
        .catch((error) => {
          console.warn("[ai-chat] allowance finish failed", {
            runId,
            outcome,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    };
  }

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

  /** LCA-14：AI 开关关闭/未入灰度批次时拒绝（计量预留之前）。 */
  async function requireAiCapability(user: AppBindings["Variables"]["user"]): Promise<void> {
    const db = workspaceDb(user);
    if (!db || !deps.checkAiCapability) return;
    let allowed: boolean;
    try {
      allowed = await deps.checkAiCapability(db);
    } catch {
      throw new HttpError(503, "ai-capability-unavailable", "AI 能力开关状态暂不可读");
    }
    if (!allowed) throw new HttpError(503, "ai-capability-disabled", "AI 能力已临时关闭或本工作区不在灰度批次内");
  }

  async function resumeRun(input: {
    runId: string;
    decision: ResumeDecision;
    user: AppBindings["Variables"]["user"];
  }): Promise<{ runId: string; streamUrl: string; streamToken: string }> {
    const { runId, decision, user } = input;
    const known = deps.registry.get(runId);
    if (known && known.ownerSubject !== user.subject) throw new HttpError(403, "chat-run-forbidden", "Run is not owned by caller");
    await requireAiCapability(user);
    // 内存 registry 只负责 stream；运行归属和并发窗口由当前 workspace 的持久化记录决定。
    const session = await signIn(user.rawToken);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await claimResumeWindow(session, runId);
      const resumeDb = workspaceDb(user);
      if (deps.allowance?.resume && resumeDb) {
        try {
          await deps.allowance.resume({ db: resumeDb, actor: await callerUserId(session),
            runId, actionKey: AI_CHAT_ACTION_KEY, idempotencyKey: `${runId}:resume:${JSON.stringify(decision)}` });
        } catch (error) { allowanceFail(error); }
      }
      const finish = deps.allowance && resumeDb ? meteredTerminalHandler(resumeDb, runId) : undefined;
      const onTerminal = async (outcome: RunTerminalOutcome) => {
        finish?.(outcome);
        await release?.();
      };
      const { streamToken } = deps.registry.register({ runId, ownerSubject: user.subject });
      await deps.service.resumeChat({ runId, decision, surrealSession: session, ownerSubject: user.subject,
        openContentSession: deps.createContentResearchSession ? () => deps.createContentResearchSession!(user) : undefined,
        onTerminal });
      return { runId, streamUrl: `/api/chat/stream?runId=${runId}`, streamToken };
    } catch (error) {
      await release?.();
      await closeCallerSessionQuietly(session);
      throw error;
    }

  }

  return new Hono<AppBindings>()
    .post("/api/chat/runs/:runId/resume", requireUser(), resumeDecisionJson, async (c) => {
      const parsed = c.req.valid("json");
      const result = await resumeRun({
        runId: parsed.runId,
        decision: parsed.decision,
        user: c.var.user,
      });
      return c.json(result);
    })
    .post("/api/chat", requireUser(), async (c) => {
      const body = await c.req.json().catch(() => null);
      const user = c.var.user;

      // ── resume 路径 ──
      if (body?.resume !== undefined && body?.resume !== null) {
        const parsed = ResumeAiWorkflowRequestSchema.safeParse(body.resume);
        if (!parsed.success) {
          throw new HttpError(400, "chat-resume-invalid", "resume payload is invalid", parsed.error.flatten());
        }
        const { runId, decision } = parsed.data;
        return c.json(await resumeRun({ runId, decision: decision as ResumeDecision, user }));
      }

      // ── 新 run 路径 ──
      const message = typeof body?.message === "string" ? body.message : undefined;
      if (!message) {
        throw new HttpError(400, "chat-message-required", "message is required");
      }
      // LCA-14：开关判定早于 caller session / 额度预留——关闭期间不产生计费。
      await requireAiCapability(user);
      // contextSnapshot 可省略（service 会注入合法默认快照）；一旦提供就必须满足 schema，
      // 在 signIn 之前 fail-fast——不能先 200 受理再让 workflow 内部炸出不透明错误。
      let userContext: AiContextSnapshot | undefined;
      if (body?.contextSnapshot !== undefined && body?.contextSnapshot !== null) {
        const parsed = AiContextSnapshotSchema.safeParse(body.contextSnapshot);
        if (!parsed.success) {
          throw new HttpError(400, "chat-context-invalid", "contextSnapshot is invalid", parsed.error.flatten());
        }
        userContext = parsed.data as AiContextSnapshot;
      }
      const composerMode = body?.composerMode === "resource-search" || body?.composerMode === "chat"
        ? (body.composerMode as "chat" | "resource-search")
        : undefined;

      const session = await signIn(user.rawToken);

      const runId = crypto.randomUUID();
      // 客户端可带幂等键：同一次提交的网络重试不会重复预留/扣款。
      const idempotencyKey = typeof body?.idempotencyKey === "string" && body.idempotencyKey.length > 0
        ? body.idempotencyKey
        : runId;

      // 计量门禁：在启动 workflow（调用模型）之前原子预留披露上限。
      let meteredDb: string | undefined;
      const gateDb = workspaceDb(user);
      if (deps.allowance && gateDb) {
        try {
          const actor = await callerUserId(session);
          const begun = await deps.allowance.reserve({
            db: gateDb,
            actor,
            channel: "interactive",
            actionKey: AI_CHAT_ACTION_KEY,
            idempotencyKey,
            runId,
          });
          if (begun.metered) meteredDb = gateDb;
        } catch (error) {
          await closeCallerSessionQuietly(session);
          return allowanceFail(error);
        }
      }

      const { streamToken } = deps.registry.register({ runId, ownerSubject: user.subject });

      try {
        await deps.service.startChat({
          runId,
          message,
          userContext,
          surrealSession: session,
          ownerSubject: user.subject,
          composerMode,
          // 惰性工厂：executor 在执行窗口内才打开 content_reader 会话；闭包持有调用者 token，
          // 不进入 workflow state / 消息 / 日志。
          openContentSession: deps.createContentResearchSession
            ? () => deps.createContentResearchSession!(user)
            : undefined,
          onTerminal: meteredDb ? meteredTerminalHandler(meteredDb, runId) : undefined,
        });
      } catch (error) {
        if (meteredDb) {
          await deps.allowance
            ?.finishByRun({ db: meteredDb, runId, outcome: "failure" })
            .catch(() => undefined);
        }
        await closeCallerSessionQuietly(session);
        throw error;
      }

      return c.json({ runId, streamUrl: `/api/chat/stream?runId=${runId}`, streamToken });
    });
}
