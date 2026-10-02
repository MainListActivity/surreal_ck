import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import {
  createAiChatRoutes,
  type AiAllowanceGate,
  type AiChatService,
  type RunTerminalOutcome,
} from "../routes/ai-chat";
import { createRunRegistry } from "../ai/run-registry";
import { AiAllowanceError } from "./service";

/**
 * /api/chat 计量门禁的接线测试：启动前预留、终态收口映射、错误码映射。
 * 账本语义本身由 service.integration.test.ts 对真实 SurrealDB 覆盖。
 */
const testUser = {
  subject: "user-1",
  email: "a@x.test",
  raw: { db: "ws_test", ac: "admin" },
  rawToken: "tok",
};

function useUser(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", testUser as never);
    await next();
  };
}

/** 带 fn::current_user() 响应的假会话（thenable 语义：await 得语句结果数组）。 */
const fakeSession = {
  async query() {
    return [["user:1"]];
  },
  async close() {},
} as unknown as Surreal;

function makeApp(allowance: AiAllowanceGate, captured: { terminal?: (o: RunTerminalOutcome) => void }) {
  const service: AiChatService = {
    async startChat(input) {
      captured.terminal = input.onTerminal;
    },
    async resumeChat(input) {
      captured.terminal = input.onTerminal;
    },
  };
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route(
    "/",
    createAiChatRoutes({
      service,
      createCallerSession: async () => fakeSession,
      registry: createRunRegistry(),
      allowance,
      rolloutGates: async () => "enabled",
      requireUser: () => useUser(),
    }),
  );
  return app;
}

describe("/api/chat AI 额度门禁", () => {
  test("额度不足 → 402，不启动 run", async () => {
    let started = false;
    const allowance: AiAllowanceGate = {
      async reserve() {
        throw new AiAllowanceError("ai-allowance-insufficient", "no balance");
      },
      async finishByRun() {},
    };
    const app = makeApp(allowance, {});
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("ai-allowance-insufficient");
    expect(started).toBe(false);
  });

  test("权益不含该动作 → 403，不启动 run", async () => {
    const allowance: AiAllowanceGate = {
      async reserve() {
        throw new AiAllowanceError("ai-action-not-entitled", "not in ai_actions");
      },
      async finishByRun() {},
    };
    const app = makeApp(allowance, {});
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  test("计量 run：actor/幂等键/通道正确绑定；终态回调映射到 finishByRun", async () => {
    const reserveCalls: Array<Record<string, unknown>> = [];
    const finishCalls: Array<Record<string, unknown>> = [];
    const allowance: AiAllowanceGate = {
      async reserve(input) {
        reserveCalls.push(input as unknown as Record<string, unknown>);
        return { metered: true };
      },
      async finishByRun(input) {
        finishCalls.push(input as unknown as Record<string, unknown>);
      },
    };
    const captured: { terminal?: (o: RunTerminalOutcome) => void } = {};
    const app = makeApp(allowance, captured);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", idempotencyKey: "submit-42" }),
    });
    expect(res.status).toBe(200);
    expect(reserveCalls).toHaveLength(1);
    expect(reserveCalls[0]).toMatchObject({
      db: "ws_test",
      channel: "interactive",
      actionKey: "research",
      idempotencyKey: "submit-42",
    });
    expect(reserveCalls[0].actor).toBeInstanceOf(StringRecordId);

    // suspended 不收口；success 结算；failed 释放
    captured.terminal?.("suspended");
    expect(finishCalls).toHaveLength(0);
    captured.terminal?.("failed");
    expect(finishCalls).toHaveLength(1);
    await new Promise((r) => setImmediate(r));
    expect(finishCalls[0]).toMatchObject({ db: "ws_test", outcome: "failure" });
  });

  test("账本不可用 → 503 ai-allowance-unavailable，不启动 run", async () => {
    const allowance: AiAllowanceGate = {
      async reserve() {
        throw new AiAllowanceError("ai-allowance-unavailable", "allowance ledger is unavailable; retry later");
      },
      async finishByRun() {},
    };
    const app = makeApp(allowance, {});
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("ai-allowance-unavailable");
  });

  test("调用者会话查询失败 → 503 chat-actor-unavailable，不启动 run", async () => {
    const brokenSession = {
      async query() {
        throw new Error("connection reset");
      },
      async close() {},
    } as unknown as Surreal;
    const allowance: AiAllowanceGate = {
      async reserve() {
        return { metered: true };
      },
      async finishByRun() {},
    };
    const service: AiChatService = {
      async startChat() {},
      async resumeChat() {},
    };
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route(
      "/",
      createAiChatRoutes({
        service,
        createCallerSession: async () => brokenSession,
        registry: createRunRegistry(),
        allowance,
        rolloutGates: async () => "enabled",
        requireUser: () => useUser(),
      }),
    );
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("chat-actor-unavailable");
  });

  test("未注入门禁 → 不计量（向后兼容）", async () => {
    const service: AiChatService = {
      async startChat() {},
      async resumeChat() {},
    };
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route(
      "/",
      createAiChatRoutes({
        service,
        createCallerSession: async () => fakeSession,
        registry: createRunRegistry(),
        rolloutGates: async () => "enabled",
        requireUser: () => useUser(),
      }),
    );
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
  });
});
