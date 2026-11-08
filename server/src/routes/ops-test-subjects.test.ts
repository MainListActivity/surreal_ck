import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { createOpsTestSubjectsRoutes } from "./ops-test-subjects";
import type { Queryable } from "../test-subjects/store";

function allowAs(subject = "op-user-1"): () => MiddlewareHandler<AppBindings> {
  return () => async (c, next) => {
    c.set("platformOperator", { subject, capabilities: ["test.manage"] });
    await next();
  };
}

function deny(): () => MiddlewareHandler<AppBindings> {
  return () => async (c) => c.json({ error: "forbidden" }, 403);
}

/** 可编程内存 Queryable：按 SQL 片段返回预置行，并记录写操作。 */
function fakeDb(seed: { sql: string; rows?: Record<string, unknown>[] }[] = []) {
  const writes: { sql: string; params: Record<string, unknown> }[] = [];
  const tables = new Map<string, Record<string, unknown>[]>();
  const db: Queryable = {
    async query(sql: string, params: Record<string, unknown> = {}) {
      for (const rule of seed) {
        if (sql.includes(rule.sql)) return [rule.rows ?? []];
      }
      if (/^(INSERT|UPDATE|DELETE|CREATE|REMOVE)/.test(sql.trim())) {
        writes.push({ sql, params });
        // test_subject upsert 后 findTestSubject 读回
        if (sql.includes("INSERT INTO test_subject")) {
          const rows = tables.get("test_subject") ?? [];
          rows.push({
            id: "test_subject:x",
            subject: params.subject,
            email: params.email,
            expires_at: params.expiresAt instanceof Date ? params.expiresAt.toISOString() : params.expiresAt,
            origin: params.origin,
          });
          tables.set("test_subject", rows);
        }
        if (sql.includes("DELETE test_subject")) {
          tables.set("test_subject", (tables.get("test_subject") ?? []).filter((r) => r.subject !== params.subject));
        }
        return [[]];
      }
      if (sql.includes("FROM test_subject")) {
        const rows = (tables.get("test_subject") ?? [])
          .filter((r) => !sql.includes("$subject") || r.subject === params.subject);
        return [rows];
      }
      return [[]];
    },
  };
  return { db, writes, tables };
}

const FUTURE = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();

describe("PUT /api/ops/test-subjects/:subject", () => {
  test("登记测试主体并回填单成员 workspace", async () => {
    const { db, writes } = fakeDb([
      // 无既有 operator
      { sql: "FROM platform_operator WHERE subject", rows: [] },
      // 一个单成员 workspace
      { sql: "VALUE workspace FROM user_workspace_index", rows: [{ workspace: "workspace:w1" }] },
      { sql: "count() AS n", rows: [{ n: 1 }] },
    ]);
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const res = await app.request("/api/ops/test-subjects/subj_1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: FUTURE, origin: "task-x", contentCapabilities: ["content.submit"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("subj_1");
    expect(writes.some((w) => w.sql.includes("INSERT INTO test_subject"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("platform_operator_capability"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("test_expires_at"))).toBe(true);
  });

  test("expiresAt 超出 31 天窗口拒绝", async () => {
    const { db } = fakeDb();
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const res = await app.request("/api/ops/test-subjects/s", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: new Date(Date.now() + 40 * 24 * 3600_000).toISOString() }),
    });
    expect(res.status).toBe(400);
  });

  test("正式运营主体冲突返回 409", async () => {
    const { db } = fakeDb([
      { sql: "FROM platform_operator WHERE subject", rows: [{ id: "platform_operator:x" }] },
    ]);
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const res = await app.request("/api/ops/test-subjects/formal-op", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: FUTURE }),
    });
    expect(res.status).toBe(409);
  });

  test("非法 capability 400", async () => {
    const { db } = fakeDb([{ sql: "FROM platform_operator WHERE subject", rows: [] }]);
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const res = await app.request("/api/ops/test-subjects/s", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: FUTURE, contentCapabilities: ["quota.read"] }),
    });
    expect(res.status).toBe(400);
  });

  test("无 test.manage 403", async () => {
    const app = createOpsTestSubjectsRoutes({ requireOperator: deny(), getSystemDb: async () => fakeDb().db });
    const res = await app.request("/api/ops/test-subjects/s", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: FUTURE }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/ops/test-subjects", () => {
  test("列出主体与关联 workspace", async () => {
    const { db } = fakeDb([
      { sql: "FROM test_subject ORDER BY", rows: [{ subject: "s1", email: null, expires_at: FUTURE, origin: "t" }] },
      { sql: "workspace.slug", rows: [{ slug: "ws-a" }] },
    ]);
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const res = await app.request("/api/ops/test-subjects");
    expect(res.status).toBe(200);
    const body = await res.json() as { subjects: { subject: string; workspaces: unknown[] }[] };
    expect(body.subjects[0].subject).toBe("s1");
    expect(body.subjects[0].expired).toBe(false);
  });
});

describe("DELETE /api/ops/test-subjects/:subject", () => {
  test("清除 workspace 与 operator 并删除 test_subject", async () => {
    const { db, writes } = fakeDb([
      { sql: "SELECT subject FROM test_subject", rows: [{ subject: "s1" }] },
      { sql: "subject FROM user_workspace_index", rows: [{ subject: "s1" }] },
      { sql: "VALUE workspace FROM user_workspace_index", rows: [{ workspace: "workspace:w1" }] },
      { sql: "FROM workspace WHERE id", rows: [{ id: "workspace:w1", slug: "w1", db_name: "db1", owner_subject: "s1", test_origin: null }] },
    ]);
    const dropped: string[] = [];
    const app = createOpsTestSubjectsRoutes({
      requireOperator: allowAs(),
      getSystemDb: async () => db,
      dropDatabase: async (name) => { dropped.push(name); },
    });
    const res = await app.request("/api/ops/test-subjects/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(dropped).toEqual(["db1"]);
    expect(writes.some((w) => w.sql.includes("DELETE workspace WHERE id"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("DELETE test_subject"))).toBe(true);
  });

  test("含非测试成员的 workspace 跳过不删", async () => {
    const { db } = fakeDb([
      { sql: "SELECT subject FROM test_subject", rows: [{ subject: "s1" }] },
      { sql: "subject FROM user_workspace_index", rows: [{ subject: "s1" }, { subject: "normal_user" }] },
      { sql: "VALUE workspace FROM user_workspace_index", rows: [{ workspace: "workspace:w1" }] },
      { sql: "FROM workspace WHERE id", rows: [{ id: "workspace:w1", slug: "w1", db_name: "db1", owner_subject: "s1", test_origin: null }] },
    ]);
    const dropped: string[] = [];
    const app = createOpsTestSubjectsRoutes({
      requireOperator: allowAs(),
      getSystemDb: async () => db,
      dropDatabase: async (name) => { dropped.push(name); },
    });
    const res = await app.request("/api/ops/test-subjects/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspacesSkipped).toBe(1);
    expect(dropped).toEqual([]);
  });
});
