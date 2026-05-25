import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createAiChatRoutes, type AiChatService, type CallerSessionFactory } from "./ai-chat";
import { createRunRegistry } from "../ai/run-registry";

const testUser = {
  subject: "user-123",
  email: "ada@example.test",
  raw: { "https://surrealdb.com/db": "ws_demo", "https://surrealdb.com/ac": "admin" },
  rawToken: "test-token",
};

function useUser(subject = testUser.subject): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", { ...testUser, subject });
    await next();
  };
}

const fakeSession = { close: async () => {} } as unknown as Surreal;

// 永远成功的会话工厂：把 rawToken authenticate 后的会话交给 service。
const okSessionFactory: CallerSessionFactory = async () => fakeSession;

type StartCall = { message: string; session: Surreal; runId: string };
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
      startCalls.push({ message: input.message, session: input.surrealSession, runId: input.runId });
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
      requireUser: opts.requireUser === "real" ? undefined : (opts.requireUser ?? (() => useUser())),
    }),
  );
  return app;
}

describe("POST /api/chat", () => {
  test("有效 token + message → 200 返回 runId / streamUrl / streamToken，并后台启动 workflow", async () => {
    const service = stubService();
    const app = makeApp({ service });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "打开债权工作簿" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamUrl: string; streamToken: string };
    expect(body.runId).toBeTruthy();
    expect(body.streamToken).toBeTruthy();
    expect(body.streamUrl).toBe(`/api/chat/stream?runId=${body.runId}`);

    // workflow 已用调用者 session + message + 同一 runId 在后台启动
    expect(service.startCalls).toHaveLength(1);
    expect(service.startCalls[0].message).toBe("打开债权工作簿");
    expect(service.startCalls[0].session).toBe(fakeSession);
    expect(service.startCalls[0].runId).toBe(body.runId);
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
      body: JSON.stringify({ message: "找张三的债权" }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: { runId, decision: { kind: "candidate-chosen", candidateId: "claim:abc" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamUrl: string; streamToken: string };
    expect(body.runId).toBe(runId);
    expect(body.streamUrl).toBe(`/api/chat/stream?runId=${runId}`);

    expect(service.resumeCalls).toHaveLength(1);
    expect(service.resumeCalls[0].runId).toBe(runId);
    expect(service.resumeCalls[0].decision).toEqual({ kind: "candidate-chosen", candidateId: "claim:abc" });
    // 用新建的 session（workflow state 不持有旧 session）
    expect(service.resumeCalls[0].session).toBe(fakeSession);
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
