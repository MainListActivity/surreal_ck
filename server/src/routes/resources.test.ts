import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Surreal } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import type { CallerSessionFactory } from "./ai-chat";
import type { EmbeddingProvider } from "../resources/research-save";
import { createResourceRoutes } from "./resources";

const testUser = {
  subject: "user-123",
  email: "ada@example.test",
  raw: { db: "ws_demo", ac: "admin" },
  rawToken: "test-token",
};

function useUser(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", { ...testUser });
    await next();
  };
}

type QueryCall = { sql: string; binds: Record<string, unknown> | undefined };

function fakeSession(options: { profile?: Record<string, unknown> | null } = {}) {
  const calls: QueryCall[] = [];
  const session = {
    async query(sql: string, binds?: Record<string, unknown>) {
      calls.push({ sql, binds });
      if (sql.includes("FROM ONLY workspace_embedding_profile")) {
        return [options.profile ?? null];
      }
      return [null];
    },
    async close() {},
  } as unknown as Surreal;
  return { session, calls };
}

const profile = { provider: "openai", model: "m", dimensions: 2, version: "v1" };
const okProvider: EmbeddingProvider = { async embed() { return [0.5, 0.5]; } };

function makeApp(opts: {
  sessionFactory?: CallerSessionFactory;
  embeddingProvider?: EmbeddingProvider;
  requireUser?: (() => MiddlewareHandler<AppBindings>) | "real";
}) {
  const { session, calls } = fakeSession({ profile });
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route(
    "/",
    createResourceRoutes({
      createCallerSession: opts.sessionFactory ?? (async () => session),
      embeddingProvider: opts.embeddingProvider ?? okProvider,
      requireUser: opts.requireUser === "real" ? undefined : (opts.requireUser ?? (() => useUser())),
    }),
  );
  return { app, calls };
}

function validBody() {
  return {
    sessionId: "research_session:s1",
    draft: {
      title: "标题",
      summary: "摘要",
      evidence: [
        { text: "证据", capturedAt: "2026-06-11T08:00:00.000Z", order: 0 },
      ],
    },
  };
}

/** 把 SSE 响应体解析为 [{event, data}]。 */
function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      return {
        event: eventLine?.slice("event:".length).trim() ?? "",
        data: JSON.parse(dataLine?.slice("data:".length).trim() ?? "{}") as Record<string, unknown>,
      };
    });
}

describe("POST /api/resources/research/save", () => {
  test("有效草稿 → SSE 按序推 validating/embedding/persisting/session-updated/done，写入走调用者 session", async () => {
    const { app, calls } = makeApp({});

    const res = await app.request("/api/resources/research/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(await res.text());
    expect(events.map((item) => item.event)).toEqual([
      "validating",
      "embedding",
      "persisting",
      "session-updated",
      "done",
    ]);
    const done = events.at(-1)!.data;
    expect(String(done.resourceId)).toContain("resource_item:");

    // 资源 + 向量 + session 更新落在调用者 session 的保存事务里
    const tx = calls.find((call) => call.sql.includes("BEGIN TRANSACTION"));
    expect(tx).toBeDefined();
    expect(tx!.sql).toContain("resource_embedding");
  });

  test("embedding 失败 → SSE 以 error(stage=embedding) 结束，HTTP 仍是 200 流", async () => {
    const { app } = makeApp({
      embeddingProvider: { async embed() { throw new Error("provider down"); } },
    });

    const res = await app.request("/api/resources/research/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    const events = parseSse(await res.text());
    expect(events.at(-1)!.event).toBe("error");
    expect(events.at(-1)!.data.stage).toBe("embedding");
  });

  test("缺 Bearer token → 401（真实 requireOidc）", async () => {
    const { app } = makeApp({ requireUser: "real" });
    const res = await app.request("/api/resources/research/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  test("workspace SIGNIN 失败 → 403，不开始 SSE", async () => {
    const { app } = makeApp({
      sessionFactory: async () => {
        throw new Error("authenticate rejected");
      },
    });
    const res = await app.request("/api/resources/research/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(403);
  });

  test("路由注册表只有这一个资源 endpoint：没有通用 CRUD / enqueue / retry / reindex", () => {
    const routes = createResourceRoutes({
      createCallerSession: async () => fakeSession().session,
    }).routes.filter((route) => route.method !== "ALL");

    // 中间件与 handler 在 .routes 各占一条，按 method+path 去重后只允许这一个入口
    const unique = [...new Set(routes.map((route) => `${route.method} ${route.path}`))];
    expect(unique).toEqual(["POST /api/resources/research/save"]);
  });
});
