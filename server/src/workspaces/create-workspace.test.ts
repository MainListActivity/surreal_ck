import { describe, expect, test } from "bun:test";
import type { WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { createWorkspaceCreator, type CreateWorkspaceClient } from "./create-workspace";
import type { IdpTokenScopeAdapter } from "./idp-scope-adapter";
import type { SurrealTokenScope } from "./workspace-scope";

class FakeDb implements CreateWorkspaceClient {
  readonly queries: Array<{ sql: string; params?: Record<string, unknown>; database: string }> = [];
  readonly useCalls: Array<{ namespace: string; database: string }> = [];
  currentDatabase = "_system";

  // slug 已存在的集合（命中则 workspace 查询返回一行）
  existingSlugs = new Set<string>();
  // 让指定库的某条查询抛错，用于补偿路径
  failOn?: { database: string; match: string };

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
    this.currentDatabase = scope.database;
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<any[]> {
    this.queries.push({ sql, params, database: this.currentDatabase });
    const normalized = sql.trim().replace(/\s+/g, " ");

    if (this.failOn && this.currentDatabase === this.failOn.database && normalized.includes(this.failOn.match)) {
      throw new Error("simulated query failure");
    }

    if (normalized.includes("FROM workspace WHERE slug")) {
      const slug = params?.slug;
      return [this.existingSlugs.has(slug as string) ? [{ id: "workspace:existing" }] : []];
    }

    return [[]];
  }
}

function recordingIdpAdapter(): { adapter: IdpTokenScopeAdapter; calls: Array<{ subject: string; scope: SurrealTokenScope }> } {
  const calls: Array<{ subject: string; scope: SurrealTokenScope }> = [];
  return {
    calls,
    adapter: {
      async updateUserScope(subject, scope) {
        calls.push({ subject, scope });
      },
    },
  };
}

const templateScripts: WorkspaceTemplateScript[] = [
  { version: 1, name: "001-access.surql", sql: "DEFINE ACCESS admin ON DATABASE TYPE JWT URL 'x';" },
  { version: 2, name: "002-tables-core.surql", sql: "DEFINE TABLE user SCHEMAFULL;" },
];

describe("createWorkspace lifecycle", () => {
  test("provisions db, applies template, seeds owner user and _system index, then updates IdP scope", async () => {
    const db = new FakeDb();
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      db,
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace({
      subject: "user-123",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    expect(result).toEqual({
      kind: "created",
      slug: "acme",
      dbName: "ws_abcdef123456",
      refreshRequired: true,
    });

    // 1. root 建库
    const defineDb = db.queries.find((q) => q.sql.includes("DEFINE DATABASE") && q.sql.includes("ws_abcdef123456"));
    expect(defineDb).toBeDefined();

    // 2. 模板在新库内被应用
    const templateApplied = db.queries.filter((q) => q.database === "ws_abcdef123456" && q.sql.includes("DEFINE"));
    expect(templateApplied.length).toBeGreaterThanOrEqual(2);

    // 3. owner user 写入新库，human + is_admin=true
    const ownerInsert = db.queries.find((q) => q.database === "ws_abcdef123456" && q.sql.includes("user") && q.sql.includes("INSERT"));
    expect(ownerInsert).toBeDefined();
    expect(ownerInsert?.params?.subject).toBe("user-123");
    expect(ownerInsert?.params?.email).toBe("ada@example.test");

    // 4. _system.workspace 与 user_workspace_index 双写
    const workspaceRow = db.queries.find((q) => q.database === "_system" && q.sql.includes("workspace") && q.sql.includes("CONTENT"));
    expect(workspaceRow).toBeDefined();
    const indexRow = db.queries.find((q) => q.database === "_system" && q.sql.includes("user_workspace_index"));
    expect(indexRow).toBeDefined();
    expect(indexRow?.params?.role).toBe("admin");

    // 5. IdP adapter 被调用一次，指向新库 admin scope
    expect(calls).toEqual([{ subject: "user-123", scope: { db: "ws_abcdef123456", ac: "admin" } }]);
  });

  test("returns slug-conflict and never creates a database when slug already exists", async () => {
    const db = new FakeDb();
    db.existingSlugs.add("acme");
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      db,
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace({
      subject: "user-123",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    expect(result).toEqual({ kind: "slug-conflict" });
    expect(db.queries.find((q) => q.sql.includes("DEFINE DATABASE"))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("drops the freshly-created database and throws when template application fails", async () => {
    const db = new FakeDb();
    // 模板 SQL 在新库内执行时失败
    db.failOn = { database: "ws_abcdef123456", match: "DEFINE TABLE user" };
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      db,
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    await expect(
      creator.createWorkspace({
        subject: "user-123",
        email: "ada@example.test",
        name: "Acme Legal",
        slug: "acme",
      }),
    ).rejects.toThrow(/template apply failed/);

    // 补偿：REMOVE DATABASE 在 _system 上执行
    const dropQuery = db.queries.find((q) => q.sql.includes("REMOVE DATABASE") && q.sql.includes("ws_abcdef123456"));
    expect(dropQuery).toBeDefined();
    expect(dropQuery?.database).toBe("_system");
    // 不写 _system.workspace，不调 IdP
    expect(db.queries.find((q) => q.sql.includes("CREATE workspace"))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("returns scope-update-failed and keeps the database when IdP scope update fails", async () => {
    const db = new FakeDb();
    const failingAdapter: IdpTokenScopeAdapter = {
      async updateUserScope() {
        throw new Error("idp unreachable");
      },
    };

    const creator = createWorkspaceCreator({
      db,
      idpTokenScopeAdapter: failingAdapter,
      loadTemplateScripts: async () => templateScripts,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace({
      subject: "user-123",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    expect(result).toEqual({ kind: "scope-update-failed", slug: "acme", dbName: "ws_abcdef123456" });
    // db 与 _system 记录保留，不补偿删除
    expect(db.queries.find((q) => q.sql.includes("CREATE workspace"))).toBeDefined();
    expect(db.queries.find((q) => q.sql.includes("REMOVE DATABASE"))).toBeUndefined();
  });
});
