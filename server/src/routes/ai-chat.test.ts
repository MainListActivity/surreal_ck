import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createAiChatRoutes, type AiChatService, type CallerSessionFactory } from "./ai-chat";
import { ChatDeliveryStore } from "../ai/delivery-store";
import { createRunRegistry } from "../ai/run-registry";
import { attachRunDiagnostics } from "../ai/caller-session";
import { createRunDiagnostics } from "../ai/run-diagnostics";

const testUser = {
  subject: "user-123",
  email: "ada@example.test",
  raw: { db: "ws_demo", ac: "admin" },
  rawToken: "test-token",
};

function useUser(subject = testUser.subject): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", { ...testUser, subject });
    await next();
  };
}

const fakeSession = { close: async () => {}, query: async (_sql: string, params: Record<string, unknown>) => [[{ id: "workflow_run:fixture", resume_fence: params?.fence }]] } as unknown as Surreal;

// 永远成功的会话工厂：把 rawToken authenticate 后的会话交给 service。
const okSessionFactory: CallerSessionFactory = async () => fakeSession;

function closableSession() {
  const closed: string[] = [];
  return {
    session: {
      async close() {
        closed.push("closed");
      },
    } as unknown as Surreal,
    closed,
  };
}

type StartCall = { message: string; session: Surreal; runId: string; userContext?: unknown; composerMode?: "chat" | "resource-search" };
type ResumeCall = { runId: string; decision: unknown; session: Surreal };

function stubService(
  overrides: Partial<AiChatService> = {},
): AiChatService & { startCalls: StartCall[]; resumeCalls: ResumeCall[] } {
  const startCalls: StartCall[] = [];
  const resumeCalls: ResumeCall[] = [];
  return {
    startCalls,
    resumeCalls,
    async startChat(input) {
      startCalls.push({ message: input.message, session: input.surrealSession, runId: input.runId, userContext: input.userContext, composerMode: input.composerMode });
      // 后台启动语义：立即 resolve（真实实现里 workflow 在后台继续跑）。
    },
    async resumeChat(input) {
      resumeCalls.push({ runId: input.runId, decision: input.decision, session: input.surrealSession });
    },
    ...overrides,
  } as AiChatService & { startCalls: StartCall[]; resumeCalls: ResumeCall[] };
}

function makeApp(opts: {
  service?: AiChatService;
  sessionFactory?: CallerSessionFactory;
  registry?: ReturnType<typeof createRunRegistry>;
  deliveries?: ChatDeliveryStore;
  /** LCA14：默认放行；注入 disabled/抛错替身覆盖开关拒绝与 fail closed 路径。 */
  rolloutGates?: import("../rollout/gate-check").RolloutGateChecker;
  /** 传 undefined 时用真实 requireOidc（用于鉴权失败用例）。 */
  requireUser?: (() => MiddlewareHandler<AppBindings>) | "real";
}) {
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route(
    "/",
    createAiChatRoutes({
      service: opts.service ?? stubService(),
      createCallerSession: opts.sessionFactory ?? okSessionFactory,
      registry: opts.registry ?? createRunRegistry(),
      deliveries: opts.deliveries,
      rolloutGates: opts.rolloutGates ?? (async () => "enabled"),
      requireUser: opts.requireUser === "real" ? undefined : (opts.requireUser ?? (() => useUser())),
    }),
  );
  return app;
}

describe("POST /api/chat", () => {
  test("composerMode=resource-search 透传给 service；非法值被丢弃", async () => {
    const service = stubService();
    const app = makeApp({ service });

    const ok = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "查找设备故障案例", composerMode: "resource-search" }),
    });
    expect(ok.status).toBe(200);
    expect(service.startCalls[0]?.composerMode).toBe("resource-search");

    const bogus = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "嗨", composerMode: "root-mode" }),
    });
    expect(bogus.status).toBe(200);
    expect(service.startCalls[1]?.composerMode).toBeUndefined();
  });

  test("有效 token + message → 200 返回 runId / streamUrl / streamToken，并后台启动 workflow", async () => {
    const service = stubService();
    const app = makeApp({ service });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "打开巡检工作簿" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamUrl: string; streamToken: string };
    expect(body.runId).toBeTruthy();
    expect(body.streamToken).toBeTruthy();
    expect(body.streamUrl).toBe(`/api/chat/stream?runId=${body.runId}`);

    // workflow 已用调用者 session + message + 同一 runId 在后台启动
    expect(service.startCalls).toHaveLength(1);
    expect(service.startCalls[0].message).toBe("打开巡检工作簿");
    expect(service.startCalls[0].session).toBe(fakeSession);
    expect(service.startCalls[0].runId).toBe(body.runId);
  });

  test("省略 contextSnapshot → 照常受理，service 层注入合法默认快照；提供了非法快照则 400 且不建会话", async () => {
    const service = stubService();
    let sessionCreated = 0;
    const app = makeApp({
      service,
      sessionFactory: async () => {
        sessionCreated += 1;
        return fakeSession;
      },
    });

    const ok = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "打开巡检工作簿" }),
    });
    expect(ok.status).toBe(200);
    expect(service.startCalls).toHaveLength(1);
    expect(service.startCalls[0]?.userContext).toBeUndefined();

    const bad = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x", contextSnapshot: { route: {} } }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error?: { code?: string } };
    expect(badBody.error?.code).toBe("chat-context-invalid");
    expect(service.startCalls).toHaveLength(1);
    // 校验在 signIn 之前完成：非法快照不消耗一次 caller session
    expect(sessionCreated).toBe(1);
  });

  test("合法 contextSnapshot 通过校验并透传（多余键被剥离）", async () => {
    const service = stubService();
    const app = makeApp({ service });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "打开工作簿",
        contextSnapshot: {
          route: { screen: "home" },
          workbook: null,
          sheet: null,
          selectedRow: null,
          contextHint: "当前在应用首页",
          workspaceSlug: "ws_demo",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(service.startCalls[0]?.userContext).toEqual({
      route: { screen: "home" },
      workbook: null,
      sheet: null,
      selectedRow: null,
      contextHint: "当前在应用首页",
    });
  });

  test("缺 Bearer token → 401（真实 requireOidc）", async () => {
    const app = makeApp({ requireUser: "real" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("token scope 指向的 workspace SIGNIN 失败 → 403，且不启动 workflow", async () => {
    const service = stubService();
    const app = makeApp({
      service,
      sessionFactory: async () => {
        throw new Error("authenticate rejected: token not scoped to this workspace as admin");
      },
    });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(403);
    expect(service.startCalls).toHaveLength(0);
  });

  test("workflow 服务启动前失败 → 关闭已经 authenticate 的 caller session", async () => {
    const { session, closed } = closableSession();
    const app = makeApp({
      sessionFactory: async () => session,
      service: stubService({
        async startChat() {
          throw new Error("service boot failed");
        },
      }),
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });

    expect(res.status).toBe(500);
    expect(closed).toEqual(["closed"]);
  });

  test("同一调用者并发两次 → 两个独立 runId，registry 各注册一条且 owner 为调用者", async () => {
    const registry = createRunRegistry();
    const app = makeApp({ registry });

    const post = () =>
      app
        .request("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "并发" }),
        })
        .then((r) => r.json() as Promise<{ runId: string; streamToken: string }>);

    const [a, b] = await Promise.all([post(), post()]);

    expect(a.runId).not.toBe(b.runId);
    for (const r of [a, b]) {
      const record = registry.get(r.runId);
      expect(record?.ownerSubject).toBe(testUser.subject);
      expect(record?.streamToken).toBe(r.streamToken);
    }
  });

  test("返回的 streamToken 是 run-scoped：registry.resolveStreamToken(runId, token) 命中", async () => {
    const registry = createRunRegistry();
    const app = makeApp({ registry });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    const { runId, streamToken } = (await res.json()) as { runId: string; streamToken: string };

    expect(registry.resolveStreamToken({ runId, streamToken })?.ownerSubject).toBe(testUser.subject);
    // 错误 token 不命中
    expect(registry.resolveStreamToken({ runId, streamToken: "wrong" })).toBeUndefined();
  });

  test("resume：本人持有的 suspended run → 用新 session 推进，提交 decision，返回同一 runId", async () => {
    const registry = createRunRegistry();
    const service = stubService();
    const app = makeApp({ registry, service });

    // 先起一个 run，模拟它已 suspend，再 resume。
    const start = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "找张三的记录" }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: { runId, decision: { kind: "candidate-chosen", candidateId: "record:abc" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamUrl: string; streamToken: string };
    expect(body.runId).toBe(runId);
    expect(body.streamUrl).toBe(`/api/chat/stream?runId=${runId}`);

    expect(service.resumeCalls).toHaveLength(1);
    expect(service.resumeCalls[0].runId).toBe(runId);
    expect(service.resumeCalls[0].decision).toEqual({ kind: "candidate-chosen", candidateId: "record:abc" });
    // 用新建的 session（workflow state 不持有旧 session）
    expect(service.resumeCalls[0].session).toBe(fakeSession);
  });

  test("resume endpoint：POST /api/chat/runs/:runId/resume 提交 decision 并返回新的 streamToken", async () => {
    const registry = createRunRegistry();
    const service = stubService();
    const app = makeApp({ registry, service });

    const start = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "找张三的记录" }),
    });
    const { runId, streamToken: firstToken } = (await start.json()) as { runId: string; streamToken: string };

    const res = await app.request(`/api/chat/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { kind: "candidate-chosen", candidateId: "record:abc" } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamUrl: string; streamToken: string };
    expect(body).toMatchObject({
      runId,
      streamUrl: `/api/chat/stream?runId=${runId}`,
    });
    expect(body.streamToken).toBeTruthy();
    expect(body.streamToken).not.toBe(firstToken);
    expect(registry.resolveStreamToken({ runId, streamToken: body.streamToken })?.ownerSubject).toBe(testUser.subject);
    expect(service.resumeCalls).toHaveLength(1);
    expect(service.resumeCalls[0].decision).toEqual({ kind: "candidate-chosen", candidateId: "record:abc" });
  });

  test("resume：用别人的 runId → 403，不调用 resumeChat", async () => {
    const registry = createRunRegistry();
    const service = stubService();

    // owner 是别人
    const ownerApp = makeApp({ registry, service, requireUser: () => useUser("someone-else") });
    const start = await ownerApp.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    const { runId } = (await start.json()) as { runId: string };

    // 当前用户（testUser）试图 resume 别人的 run
    const app = makeApp({ registry, service });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: { runId, decision: { kind: "write-confirmed" } } }),
    });

    expect(res.status).toBe(403);
    expect(service.resumeCalls).toHaveLength(0);
  });
});

describe("LCA14 legal_research_ai 灰度开关", () => {
  test("开关 disabled → 新 run 403（legal-research-ai-suspended），不签会话不启动 workflow", async () => {
    const service = stubService();
    let sessions = 0;
    const app = makeApp({
      service,
      rolloutGates: async () => "disabled",
      sessionFactory: async () => {
        sessions += 1;
        return fakeSession;
      },
    });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "检索案例" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("legal-research-ai-suspended");
    expect(sessions).toBe(0);
    expect(service.startCalls).toHaveLength(0);
  });

  test("开关读失败 → 503 fail closed，不启动 workflow", async () => {
    const service = stubService();
    const app = makeApp({
      service,
      rolloutGates: async () => { throw new Error("control plane down"); },
    });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("legal-research-ai-unavailable");
    expect(service.startCalls).toHaveLength(0);
  });

  test("开关 disabled → 暂停 run 续跑也被拒（resume = 新模型调用）", async () => {
    const registry = createRunRegistry();
    const service = stubService();
    // 开启态启动 run，随后关闭开关再续跑。
    const gate = { state: "enabled" as "enabled" | "disabled" };
    const app = makeApp({ registry, service, rolloutGates: async () => gate.state });
    const start = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    const { runId } = (await start.json()) as { runId: string };
    gate.state = "disabled";
    const res = await app.request(`/api/chat/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { kind: "write-confirmed" } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("legal-research-ai-suspended");
    expect(service.resumeCalls).toHaveLength(0);
  });
});

describe("POST /api/chat/runs/:runId/recover — suspended run 决策载荷恢复", () => {
  const deliveries = new ChatDeliveryStore("a".repeat(64));
  const writeConfirmPayload = {
    kind: "await-write-confirm",
    intent: {
      type: "row-patch-proposal",
      sheetId: "sheet:items",
      recordId: "ent_items:one",
      proposals: [
        { field: "amount", currentValue: 100, suggestedValue: 250, basis: "依据巡检附件二", confidence: "high" },
      ],
    },
  };

  /** 会话按语句分派：chat_delivery 行 + workflow_run 行 + fn::current_user() 校验。 */
  function recoverSession(input: {
    deliveryStatus: "running" | "suspended" | "complete" | "failed";
    workflowRow?: { status: string; state: unknown } | null;
  }) {
    const queries: string[] = [];
    const session = {
      close: async () => {},
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM chat_delivery")) {
          return [[{ run_id: "run-1", nonce: "n1", request_hash: "h1", status: input.deliveryStatus }]];
        }
        if (sql.includes("FROM workflow_run")) {
          return [input.workflowRow ? [input.workflowRow] : []];
        }
        if (sql.includes("RETURN fn::current_user() != NONE")) return [true];
        return [[]];
      },
    } as unknown as Surreal;
    return { session, queries };
  }

  test("suspended run：返回持久化 suspendPayload，前端据此重渲染确认卡（不连 stream、不消费决策）", async () => {
    const { session } = recoverSession({
      deliveryStatus: "suspended",
      workflowRow: {
        status: "suspended",
        state: {
          suspendedPaths: { "execute-one": [0] },
          context: {
            "execute-one": { status: "suspended", suspendPayload: writeConfirmPayload, suspendedAt: 1 },
          },
        },
      },
    });
    const app = makeApp({ deliveries, sessionFactory: async () => session });

    const res = await app.request("/api/chat/runs/run-1/recover", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string; streamUrl: string; streamToken: string;
      suspended?: { kind: string; runId: string; intent?: { type: string } };
    };
    expect(body.runId).toBe("run-1");
    expect(body.suspended).toMatchObject({ kind: "await-write-confirm", runId: "run-1", intent: { type: "row-patch-proposal" } });
    // 恢复的是等待中的确认卡：不附 streamToken，不恢复活流（决策仍走 resume 契约）。
    expect(body.streamToken).toBe("");
    expect(body.streamUrl).toBe("");
  });

  test("suspended 但持久态已被 resume 成 running 且 run 仍在执行窗：改签 streamToken 重挂 stream", async () => {
    const { session } = recoverSession({
      deliveryStatus: "suspended",
      workflowRow: { status: "running", state: { context: {} } },
    });
    const registry = createRunRegistry();
    // 模拟 resume 已受理、run 仍活跃。
    registry.register({ runId: "run-1", ownerSubject: testUser.subject });
    const app = makeApp({ deliveries, registry, sessionFactory: async () => session });

    const res = await app.request("/api/chat/runs/run-1/recover", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamUrl: string; streamToken: string; suspended?: unknown };
    expect(body.suspended).toBeUndefined();
    expect(body.streamToken).toBeTruthy();
    expect(body.streamUrl).toBe("/api/chat/stream?runId=run-1");
    expect(registry.resolveStreamToken({ runId: "run-1", streamToken: body.streamToken })?.ownerSubject).toBe(testUser.subject);
  });

  test("suspended 且 workflow_run 不可见（他人/丢失）→ 409，不泄露 run 状态", async () => {
    const { session } = recoverSession({ deliveryStatus: "suspended", workflowRow: null });
    const app = makeApp({ deliveries, sessionFactory: async () => session });

    const res = await app.request("/api/chat/runs/run-1/recover", { method: "POST" });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("chat-run-not-running");
  });

  test("suspended 但持久载荷无法映射为已知决策事件 → 409，不伪造确认卡", async () => {
    const { session } = recoverSession({
      deliveryStatus: "suspended",
      workflowRow: {
        status: "suspended",
        state: { context: { "execute-one": { status: "suspended", suspendPayload: { kind: "unknown" }, suspendedAt: 1 } } },
      },
    });
    const app = makeApp({ deliveries, sessionFactory: async () => session });

    const res = await app.request("/api/chat/runs/run-1/recover", { method: "POST" });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("chat-run-not-running");
  });
});

describe("PG-1：终态诊断快照持久化（有界 best-effort）", () => {
  test("run_diagnostic 审计写挂起：有界超时收尾，不拖住/不掩盖业务终态", async () => {
    const deliveries = new ChatDeliveryStore("a".repeat(64));
    const diag = createRunDiagnostics({ auditWriteTimeoutMs: 40 });
    const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const session = attachRunDiagnostics({
      close: async () => {},
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes("INSERT INTO chat_delivery")) {
          const content = params?.content as { run_id: string; request_hash: string; nonce: string };
          return [[{ ...content, status: "running" }]];
        }
        if (sql.includes("SELECT * FROM chat_delivery")) {
          return [[{ run_id: params?.runId, status: "running" }]];
        }
        if (sql.includes("run_diagnostic")) {
          // 诊断写自身挂起：必须由 auditWriteTimeoutMs 兜底，不能拖住终态。
          return new Promise(() => {});
        }
        return [[]];
      },
    } as unknown as Surreal, diag);
    // 终态时刻仍在飞的工具操作：审计快照必须带上。
    diag.begin({ name: "analyzeRow", phase: "tool", argShape: ["sheetId"] });

    const service = stubService({
      async startChat(input) {
        await input.onTerminal?.("failed");
      },
    });
    const app = makeApp({ service, deliveries, sessionFactory: async () => session });

    const startedAt = Date.now();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "分析一下" }),
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(res.status).toBe(200);

    const diagWrite = queries.find((q) => q.sql.includes("run_diagnostic"));
    expect(diagWrite).toBeDefined();
    const snapshot = diagWrite?.params?.diag as { reason?: string; inFlight?: Array<{ name: string; phase: string }> } | undefined;
    expect(snapshot?.reason).toBe("failed");
    expect(snapshot?.inFlight?.[0]?.name).toBe("analyzeRow");
    expect(snapshot?.inFlight?.[0]?.phase).toBe("tool");
    // 脱敏自检：快照里不允许出现参数值/SQL 原文。
    expect(JSON.stringify(snapshot)).not.toContain("分析一下");
  });
});
