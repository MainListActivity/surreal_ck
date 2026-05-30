import { describe, expect, test } from "bun:test";
import { DateTime } from "surrealdb";
import { createWorkspaceScopeModule, type Queryable } from "./workspace-scope";

class FakeDb implements Queryable {
  readonly queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  readonly useCalls: Array<{ namespace: string; database: string }> = [];

  indexRows: any[] = [];
  workspaceUserRows: Record<string, any[]> = {};
  systemAdminRowCount = 0;

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<any[]> {
    this.queries.push({ sql, params });

    const normalizedSql = sql.trim().replace(/\s+/g, " ");

    if (normalizedSql.includes("FROM system_admin")) {
      return [this.systemAdminRowCount > 0 ? ["system_admin:1"] : []];
    }

    if (normalizedSql.includes("FROM user_workspace_index")) {
      return [this.indexRows];
    }

    if (normalizedSql.includes("FROM user WHERE kind = 'human'")) {
      const currentDb = this.useCalls[this.useCalls.length - 1]?.database ?? "ws_unknown";
      const users = this.workspaceUserRows[currentDb] ?? [];
      return [users];
    }

    return [[]];
  }
}

describe("WorkspaceScopeModule.switchWorkspace consistency & drift", () => {
  test("Scenario A: successful switch when user exists in target db and role aligns", async () => {
    const db = new FakeDb();
    db.indexRows = [
      {
        id: "user_workspace_index:1",
        db_name: "ws_abc",
        role: "admin",
        workspace: { status: "active" },
        email: "ada@example.test",
      },
    ];
    db.workspaceUserRows["ws_abc"] = [
      {
        id: "user:1",
        subject: "user-123",
        email: "ada@example.test",
        is_admin: true,
      },
    ];

    const module = createWorkspaceScopeModule(db);
    const result = await module.switchWorkspace({
      subject: "user-123",
      workspaceSlug: "abc",
    });

    expect(result).toEqual({
      kind: "switched",
      scope: { db: "ws_abc", ac: "admin" },
    });
    // Should update last_selected_at
    const updateQuery = db.queries.find((q) => q.sql.includes("UPDATE") && q.sql.includes("last_selected_at"));
    expect(updateQuery).toBeDefined();
    // No role update query should be performed since they align
    const roleUpdateQuery = db.queries.find((q) => q.sql.includes("role ="));
    expect(roleUpdateQuery).toBeUndefined();
  });

  test("Scenario A (drift corrected): index role is corrected based on target db user.is_admin", async () => {
    const db = new FakeDb();
    db.indexRows = [
      {
        id: "user_workspace_index:1",
        db_name: "ws_abc",
        role: "participant", // mismatch: index says participant
        workspace: { status: "active" },
        email: "ada@example.test",
      },
    ];
    db.workspaceUserRows["ws_abc"] = [
      {
        id: "user:1",
        subject: "user-123",
        email: "ada@example.test",
        is_admin: true, // db says is_admin: true (admin)
      },
    ];

    const module = createWorkspaceScopeModule(db);
    const result = await module.switchWorkspace({
      subject: "user-123",
      workspaceSlug: "abc",
    });

    // scope ac should match the db user's admin status
    expect(result).toEqual({
      kind: "switched",
      scope: { db: "ws_abc", ac: "admin" },
    });

    // Should correct the index role to admin
    const roleUpdateQuery = db.queries.find((q) => q.sql.includes("UPDATE") && q.sql.includes("role ="));
    expect(roleUpdateQuery).toBeDefined();
    expect(roleUpdateQuery?.params?.role).toBe("admin");
  });

  test("Scenario B: binds subject by email when subject is not yet bound in target db user table", async () => {
    const db = new FakeDb();
    db.indexRows = [
      {
        id: "user_workspace_index:1",
        db_name: "ws_abc",
        role: "participant",
        workspace: { status: "active" },
        email: "ada@example.test",
      },
    ];
    db.workspaceUserRows["ws_abc"] = [
      {
        id: "user:1",
        subject: null, // subject not bound yet
        email: "ada@example.test",
        is_admin: false,
      },
    ];

    const module = createWorkspaceScopeModule(db);
    const result = await module.switchWorkspace({
      subject: "user-123",
      workspaceSlug: "abc",
    });

    expect(result).toEqual({
      kind: "switched",
      scope: { db: "ws_abc", ac: "participant" },
    });

    // Should perform update query to bind subject
    const subjectUpdateQuery = db.queries.find((q) => q.sql.includes("UPDATE") && q.sql.includes("subject ="));
    expect(subjectUpdateQuery).toBeDefined();
    expect(subjectUpdateQuery?.params?.subject).toBe("user-123");
  });

  test("Scenario C: drift conflict (409) when user is not in target db user table", async () => {
    const db = new FakeDb();
    db.indexRows = [
      {
        id: "user_workspace_index:1",
        db_name: "ws_abc",
        role: "participant",
        workspace: { status: "active" },
        email: "ada@example.test",
      },
    ];
    db.workspaceUserRows["ws_abc"] = []; // Empty: no matching user by subject or email

    const module = createWorkspaceScopeModule(db);
    const result = await module.switchWorkspace({
      subject: "user-123",
      workspaceSlug: "abc",
    });

    expect(result).toEqual({
      kind: "drift",
    });
  });

  test("Scenario C: drift conflict (409) when user matches by email but already has a different subject bound", async () => {
    const db = new FakeDb();
    db.indexRows = [
      {
        id: "user_workspace_index:1",
        db_name: "ws_abc",
        role: "participant",
        workspace: { status: "active" },
        email: "ada@example.test",
      },
    ];
    db.workspaceUserRows["ws_abc"] = [
      {
        id: "user:1",
        subject: "user-456", // different subject bound
        email: "ada@example.test",
        is_admin: false,
      },
    ];

    const module = createWorkspaceScopeModule(db);
    const result = await module.switchWorkspace({
      subject: "user-123",
      workspaceSlug: "abc",
    });

    expect(result).toEqual({
      kind: "drift",
    });
  });
});

describe("WorkspaceScopeModule disabled member filtering", () => {
  test("listWorkspaces filters out disabled index rows at the query level", async () => {
    const db = new FakeDb();
    const module = createWorkspaceScopeModule(db);

    await module.listWorkspaces({ subject: "user-123" });

    const indexQuery = db.queries.find((q) => q.sql.includes("FROM user_workspace_index"));
    expect(indexQuery?.sql).toContain("disabled_at = NONE");
  });

  test("listWorkspaces serializes SurrealDB DateTime values through SDK helpers", async () => {
    const db = new FakeDb();
    db.indexRows = [
      {
        db_name: "ws_older",
        role: "participant",
        last_selected_at: new DateTime("2026-05-22T01:00:00.000Z"),
        joined_at: new DateTime("2026-05-20T01:00:00.000Z"),
        workspace: { status: "active", slug: "older", name: "Older" },
      },
      {
        db_name: "ws_newer",
        role: "admin",
        last_selected_at: new DateTime("2026-05-23T01:00:00.000Z"),
        joined_at: new DateTime("2026-05-21T01:00:00.000Z"),
        workspace: { status: "active", slug: "newer", name: "Newer" },
      },
    ];
    const module = createWorkspaceScopeModule(db);

    const { workspaces } = await module.listWorkspaces({ subject: "user-123" });

    expect(workspaces.map((item) => item.slug)).toEqual(["newer", "older"]);
    expect(workspaces[0]?.lastSelectedAt).toBe("2026-05-23T01:00:00.000Z");
  });

  test("listWorkspaces returns canCreate=true when system_admin has any row", async () => {
    const db = new FakeDb();
    db.systemAdminRowCount = 1;
    const module = createWorkspaceScopeModule(db);

    const { canCreate } = await module.listWorkspaces({ subject: "not-in-system-admin" });

    expect(canCreate).toBe(true);
  });

  test("listWorkspaces returns canCreate=false when system_admin is empty", async () => {
    const db = new FakeDb();
    const module = createWorkspaceScopeModule(db);

    const { canCreate } = await module.listWorkspaces({ subject: "user-123" });

    expect(canCreate).toBe(false);
  });

  test("getDefaultScope filters out disabled index rows at the query level", async () => {
    const db = new FakeDb();
    const module = createWorkspaceScopeModule(db);

    await module.getDefaultScope({ subject: "user-123" });

    const indexQuery = db.queries.find((q) => q.sql.includes("FROM user_workspace_index"));
    expect(indexQuery?.sql).toContain("disabled_at = NONE");
  });
});

describe("WorkspaceScopeModule.getDefaultScope system-admin creation switch", () => {
  test("user with a workspace and empty system_admin: returns ws scope, canCreateWorkspace=false", async () => {
    const db = new FakeDb();
    db.indexRows = [
      { db_name: "ws_abc", role: "participant", workspace: { status: "active" } },
    ];
    const module = createWorkspaceScopeModule(db);

    const result = await module.getDefaultScope({ subject: "user-123" });

    expect(result).toEqual({
      kind: "scope",
      scope: { db: "ws_abc", ac: "participant" },
      canCreateWorkspace: false,
    });
  });

  test("user with a workspace and non-empty system_admin: returns ws scope, canCreateWorkspace=true", async () => {
    const db = new FakeDb();
    db.systemAdminRowCount = 1;
    db.indexRows = [
      { db_name: "ws_abc", role: "admin", workspace: { status: "active" } },
    ];
    const module = createWorkspaceScopeModule(db);

    const result = await module.getDefaultScope({ subject: "user-123" });

    expect(result).toEqual({
      kind: "scope",
      scope: { db: "ws_abc", ac: "admin" },
      canCreateWorkspace: true,
    });
  });

  test("user with no workspace and non-empty system_admin: falls back to _system admin scope", async () => {
    const db = new FakeDb();
    db.systemAdminRowCount = 1;
    const module = createWorkspaceScopeModule(db);

    const result = await module.getDefaultScope({ subject: "not-in-system-admin" });

    expect(result).toEqual({
      kind: "scope",
      scope: { db: "_system", ac: "admin" },
      canCreateWorkspace: true,
    });
  });

  test("user with no workspace and empty system_admin: login-denied", async () => {
    const db = new FakeDb();
    const module = createWorkspaceScopeModule(db);

    const result = await module.getDefaultScope({ subject: "user-123" });

    expect(result).toEqual({ kind: "login-denied", reason: "no-workspace" });
  });
});
