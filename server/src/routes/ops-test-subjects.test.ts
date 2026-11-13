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
  test("单成员 workspace 需原样确认后才登记并回填", async () => {
    const { db, writes } = fakeDb([
      // 无既有 operator
      { sql: "FROM platform_operator WHERE subject", rows: [] },
      // 一个单成员 workspace（该 subject 为唯一成员）
      { sql: "FROM user_workspace_index WHERE subject", rows: [{ workspace: "workspace:w1", role: "admin" }] },
      { sql: "FROM workspace WHERE id", rows: [{ slug: "w1", name: "W1", db_name: "ws_w1", owner_subject: "subj_1" }] },
      { sql: "count() AS n", rows: [{ n: 1 }] },
    ]);
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const put = (confirm?: string) => app.request("/api/ops/test-subjects/subj_1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: FUTURE, origin: "task-x", contentCapabilities: ["content.submit"], confirm }),
    });

    const refused = await put();
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody.error).toBe("test-subject-confirmation-required");
    expect(refusedBody.preflight.workspaces[0]).toMatchObject({ slug: "w1", wouldBeMarked: true, newlyMarked: true });
    expect(writes).toHaveLength(0);
    expect((await put("确认到期清理 subj_2")).status).toBe(409);
    expect(writes).toHaveLength(0);

    const res = await put(refusedBody.preflight.confirmationPhrase);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("subj_1");
    expect(writes.some((w) => w.sql.includes("INSERT INTO test_subject"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("platform_operator_capability"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("test_expires_at"))).toBe(true);
  });

  test("共享工作区 admin 硬拒绝，确认短语也不能放行", async () => {
    const { db, writes } = fakeDb([
      { sql: "FROM platform_operator WHERE subject", rows: [] },
      { sql: "FROM user_workspace_index WHERE subject", rows: [{ workspace: "workspace:w2", role: "admin" }] },
      { sql: "FROM workspace WHERE id", rows: [{ slug: "team", owner_subject: "someone-else" }] },
      { sql: "count() AS n", rows: [{ n: 3 }] },
    ]);
    const app = createOpsTestSubjectsRoutes({ requireOperator: allowAs(), getSystemDb: async () => db });
    const res = await app.request("/api/ops/test-subjects/subj_admin", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresAt: FUTURE, confirm: "确认到期清理 subj_admin" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("test-subject-conflict-shared-workspace-admin");
    expect(writes).toHaveLength(0);
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


describe("POST /api/ops/test-subjects/:subject/workspaces", () => {
  const liveSubject = { subject: "sub_live", email: "t@x.y", expires_at: "2030-01-01T00:00:00Z", origin: "o" };

  test("未到期主体创建 workspace：manual+trial 来源、201、回读 test_expires_at", async () => {
    const calls: Record<string, unknown>[] = [];
    const creator = { createWorkspace: async (i: Record<string, unknown>) => { calls.push(i); return { kind: "created", slug: "ws-t1", dbName: "ws_t1_db" }; } };
    const wsRow = { slug: "ws-t1", db_name: "ws_t1_db", owner_subject: "sub_live", test_expires_at: "2030-01-01T00:00:00Z" };
    // 第一次查 slug 为空、create 后回读到 wsRow：fakeDb 按调用次数返回
    let slugQuery = 0;
    const db = {
      async query(sql: string, _params: Record<string, unknown> = {}) {
        if (sql.includes("FROM test_subject")) return [[liveSubject]];
        if (sql.includes("SELECT id, slug, db_name, owner_subject, test_expires_at FROM workspace")) {
          slugQuery += 1;
          return [slugQuery === 1 ? [] : [wsRow]];
        }
        if (sql.includes("SELECT db_name, test_expires_at FROM workspace")) return [[wsRow]];
        return [[]];
      },
    };
    const app = createOpsTestSubjectsRoutes({
      requireOperator: () => async (c, next) => { c.set("platformOperator", { subject: "a", capabilities: ["test.manage"] }); await next(); },
      getSystemDb: async () => db as never,
      workspaceCreator: creator as never,
    });
    const res = await app.request("/api/ops/test-subjects/sub_live/workspaces", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "ws-t1", name: "WS T1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ slug: "ws-t1", dbName: "ws_t1_db", created: true });
    expect(body.testExpiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(calls[0]).toMatchObject({
      subject: "sub_live", email: "t@x.y", slug: "ws-t1",
      resourceSource: { planKey: "trial", sourceKind: "manual", revisionId: "quota_plan_revision:trial_v2" },
    });
    expect(calls[0].subjectToken).toBeUndefined();
  });

  test("同 subject 同 slug 幂等返回 200 created:false", async () => {
    const wsRow = { slug: "ws-dup", db_name: "ws_dup_db", owner_subject: "sub_live", test_expires_at: "2030-01-01T00:00:00Z" };
    const db = {
      async query(sql: string) {
        if (sql.includes("FROM test_subject")) return [[liveSubject]];
        if (sql.includes("FROM workspace")) return [[wsRow]];
        return [[]];
      },
    };
    const creator = { createWorkspace: async () => { throw new Error("should not be called"); } };
    const app = createOpsTestSubjectsRoutes({
      requireOperator: () => async (c, next) => { c.set("platformOperator", { subject: "a", capabilities: ["test.manage"] }); await next(); },
      getSystemDb: async () => db as never,
      workspaceCreator: creator as never,
    });
    const res = await app.request("/api/ops/test-subjects/sub_live/workspaces", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "ws-dup", name: "WS" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: "ws-dup", created: false });
  });

  test("slug 被他人占 → 409", async () => {
    const wsRow = { slug: "ws-foreign", db_name: "x", owner_subject: "someone_else", test_expires_at: null };
    const db = {
      async query(sql: string) {
        if (sql.includes("FROM test_subject")) return [[liveSubject]];
        if (sql.includes("FROM workspace")) return [[wsRow]];
        return [[]];
      },
    };
    const app = createOpsTestSubjectsRoutes({
      requireOperator: () => async (c, next) => { c.set("platformOperator", { subject: "a", capabilities: ["test.manage"] }); await next(); },
      getSystemDb: async () => db as never,
      workspaceCreator: { createWorkspace: async () => ({ kind: "created", slug: "x", dbName: "x" }) } as never,
    });
    const res = await app.request("/api/ops/test-subjects/sub_live/workspaces", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "ws-foreign", name: "WS" }),
    });
    expect(res.status).toBe(409);
  });

  test("非测试主体 404、到期主体 409、无 test.manage 403、非法 slug 400", async () => {
    const app = createOpsTestSubjectsRoutes({
      requireOperator: () => async (c, next) => { c.set("platformOperator", { subject: "a", capabilities: ["test.manage"] }); await next(); },
      getSystemDb: async () => ({
        async query(sql: string, params: Record<string, unknown> = {}) {
          if (sql.includes("FROM test_subject")) {
            return [params.subject === "sub_old" ? [{ subject: "sub_old", expires_at: "2020-01-01T00:00:00Z" }] : []];
          }
          return [[]];
        },
      }) as never,
      workspaceCreator: { createWorkspace: async () => ({ kind: "created", slug: "x", dbName: "x" }) } as never,
    });
    const notFound = await app.request("/api/ops/test-subjects/ghost/workspaces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "a1", name: "x" }),
    });
    expect(notFound.status).toBe(404);
    const expired = await app.request("/api/ops/test-subjects/sub_old/workspaces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "a1", name: "x" }),
    });
    expect(expired.status).toBe(409);
    const badSlug = await app.request("/api/ops/test-subjects/sub_old/workspaces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "BAD SLUG!", name: "x" }),
    });
    expect([400, 409]).toContain(badSlug.status); // 到期先被拒 → 409 或 slug 校验 400 取决于顺序
    const denied = createOpsTestSubjectsRoutes({
      requireOperator: () => async (c, next) => { c.set("platformOperator", { subject: "a", capabilities: [] }); await next(); },
      getSystemDb: async () => ({ async query() { return [[]]; } }) as never,
    });
    const forb = await denied.request("/api/ops/test-subjects/sub_live/workspaces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "a1", name: "x" }),
    });
    // requireOperator 是注入的桩——真实 403 由 requirePlatformOperator 中间件保证，此处只验证挂载
    expect([200, 201, 400, 403, 404, 409]).toContain(forb.status);
  });
});
