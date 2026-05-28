import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import { createApp } from "./app";
import type { AppBindings } from "./hono-types";
import { handleError } from "./middleware/error";

const useTestUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", { subject: "user-1", raw: {}, rawToken: "tok" });
  await next();
};

describe("Hono app", () => {
  test("exposes public health without requiring OIDC", async () => {
    const app = createApp();

    const response = await app.fetch(new Request("http://localhost/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "degraded",
      surrealdb: "down",
    });
    expect(typeof body.uptimeSec).toBe("number");
  });

  test("/api/chat 已挂载：未注入 AI 服务时返回 501（而非 404 / 静默 500）", async () => {
    const app = createApp({
      requireUser: () => useTestUser,
      createCallerSession: async () => ({}) as unknown as Surreal,
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("ai-not-configured");
  });

  test("/api/chat 注入 AI 服务后走通：后台启动并返回 runId + streamToken", async () => {
    const started: string[] = [];
    const fakeSession = {} as unknown as Surreal;
    const app = createApp({
      requireUser: () => useTestUser,
      createCallerSession: async () => fakeSession,
      aiChatService: {
        async startChat({ runId }) {
          started.push(runId);
        },
        async resumeChat() {},
      },
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; streamToken: string };
    expect(body.runId).toBeTruthy();
    expect(body.streamToken).toBeTruthy();
    expect(started).toEqual([body.runId]);
  });
});

describe("createApp AI 自动装配", () => {
  test("env 提供 AI provider/model/apiKey → /api/chat 不再返回 501（生产 AiChatService 自动装配）", async () => {
    const { overrideEnv } = await import("./env");
    overrideEnv({ AI_PROVIDER: "openai", AI_MODEL: "gpt-4o-mini", AI_API_KEY: "sk-test" });
    try {
      const app = createApp({
        requireUser: () => useTestUser,
        createCallerSession: async () => ({}) as unknown as Surreal,
      });
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(res.status).not.toBe(501);
    } finally {
      overrideEnv({ AI_PROVIDER: undefined, AI_MODEL: undefined, AI_API_KEY: undefined });
    }
  });
});

describe("createApp WS 接线", () => {
  test("返回 { app, websocket }：websocket handler 供 Bun.serve 用", () => {
    const built = createApp({ requireUser: () => useTestUser });
    // 旧用法：createApp() 直接当 Hono 用（fetch / request 可用）——保持兼容
    expect(typeof built.fetch).toBe("function");
    // 新增：暴露 Bun websocket handler（open/message/close）
    expect(built.websocket).toBeDefined();
    expect(typeof built.websocket.open).toBe("function");
  });

  test("/api/chat/stream 已挂载：缺 runId/streamToken 时不是 404", async () => {
    const built = createApp({ requireUser: () => useTestUser });
    // 非 WS 的普通 GET：upgrade 失败会落到 426/426-like，但绝不能是 404（路由未挂）
    const res = await built.request("/api/chat/stream");
    expect(res.status).not.toBe(404);
  });
});

describe("HTTP error handling", () => {
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
  });

  test("returns normalized 500 bodies without exposing stack traces", async () => {
    const app = new Hono();
    const logs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    app.onError(handleError);
    app.get("/boom", () => {
      throw new Error("database password leaked in stack context");
    });

    const response = await app.fetch(new Request("http://localhost/boom"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal",
        message: "Internal server error",
      },
    });
    expect(JSON.stringify(body)).not.toContain("database password");
    expect(logs.length).toBe(1);
  });
});
