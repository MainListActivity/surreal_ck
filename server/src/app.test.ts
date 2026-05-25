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
