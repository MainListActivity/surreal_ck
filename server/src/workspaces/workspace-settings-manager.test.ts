import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import { createWorkspaceSettingsManager, type WorkspaceSettingsSessionFactory } from "./workspace-settings-manager";

type QueryCall = { sql: string; params?: Record<string, unknown>; database: string };

type FakeDbState = {
  queries: QueryCall[];
  requestedSessions: string[];
  workspaces: Map<string, { id: string | RecordId | StringRecordId; dbName: string; status: string; name: string }>;
  workspaceUsers: Map<
    string,
    Array<{ id: string; subject: string | null; email: string; is_admin: boolean; kind: string; disabled_at: string | null }>
  >;
};

function createFakeDbState(): FakeDbState {
  return {
    queries: [],
    requestedSessions: [],
    workspaces: new Map(),
    workspaceUsers: new Map(),
  };
}

class FakeDb {
  constructor(
    readonly database: string,
    private readonly state: FakeDbState,
  ) {}

  async query(sql: string, params?: Record<string, unknown>): Promise<any[]> {
    this.state.queries.push({ sql, params, database: this.database });
    const normalized = sql.trim().replace(/\s+/g, " ");

    if (this.database === "_system" && normalized.includes("FROM workspace WHERE slug")) {
      const ws = this.state.workspaces.get(params?.slug as string);
      return [ws ? [{ id: ws.id, db_name: ws.dbName, status: ws.status }] : []];
    }

    if (normalized.includes("FROM user WHERE") && normalized.includes("kind = 'human'")) {
      const users = this.state.workspaceUsers.get(this.database) ?? [];
      return [
        users.filter(
          (u) =>
            u.kind === "human" &&
            u.subject === params?.callerSubject &&
            (u.disabled_at === null || u.disabled_at === undefined),
        ),
      ];
    }

    if (this.database === "_system" && normalized.startsWith("UPDATE $workspace") && normalized.includes("SET name")) {
      const target = [...this.state.workspaces.values()].find((ws) => recordIdMatches(ws.id, params?.workspace));
      if (target) target.name = params?.name as string;
      return [[]];
    }

    return [[]];
  }
}

function recordIdMatches(storedId: string | RecordId | StringRecordId, recordParam: unknown): boolean {
  if (recordParam === undefined || recordParam === null) return false;
  return storedId.toString() === recordParam.toString();
}

function fakeSessionFactory(state: FakeDbState): WorkspaceSettingsSessionFactory {
  return async (database) => {
    state.requestedSessions.push(database);
    return new FakeDb(database, state);
  };
}

describe("WorkspaceSettingsManager.renameWorkspace", () => {
  test("admin renames an active workspace in _system only", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active", name: "Old" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
    ]);
    const manager = createWorkspaceSettingsManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.renameWorkspace({ callerSubject: "admin-sub", slug: "acme", name: "Acme Legal" });

    expect(result).toEqual({ kind: "renamed" });
    expect(state.workspaces.get("acme")?.name).toBe("Acme Legal");
    expect(state.requestedSessions).toEqual(["_system", "ws_acme"]);

    const update = state.queries.find((q) => q.database === "_system" && q.sql.includes("UPDATE $workspace"));
    expect(update).toBeDefined();
    expect(update?.params?.workspace).toBeInstanceOf(StringRecordId);
    expect((update?.params?.workspace as StringRecordId).toString()).toBe("workspace:acme");
    expect(update?.params).toEqual({ workspace: update?.params?.workspace, name: "Acme Legal" });

    expect(state.queries.find((q) => q.sql.includes("db_name") && q.sql.startsWith("UPDATE"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("slug") && q.sql.startsWith("UPDATE"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("status") && q.sql.startsWith("UPDATE"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("updated_at") && q.sql.startsWith("UPDATE"))).toBeUndefined();
  });

  test("uses SurrealDB value helpers when _system returns a RecordId object", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", {
      id: new RecordId("workspace", "acme"),
      dbName: "ws_acme",
      status: "active",
      name: "Old",
    });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
    ]);
    const manager = createWorkspaceSettingsManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.renameWorkspace({ callerSubject: "admin-sub", slug: "acme", name: "New" });

    expect(result).toEqual({ kind: "renamed" });
    const update = state.queries.find((q) => q.database === "_system" && q.sql.includes("UPDATE $workspace"));
    expect(update?.params?.workspace).toBeInstanceOf(StringRecordId);
    expect((update?.params?.workspace as StringRecordId).toString()).toBe("workspace:acme");
  });

  test("returns forbidden and does not write when caller is not a workspace admin", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active", name: "Old" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:member", subject: "member-sub", email: "member@example.test", is_admin: false, kind: "human", disabled_at: null },
    ]);
    const manager = createWorkspaceSettingsManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.renameWorkspace({ callerSubject: "member-sub", slug: "acme", name: "New" });

    expect(result).toEqual({ kind: "forbidden" });
    expect(state.workspaces.get("acme")?.name).toBe("Old");
    expect(state.queries.find((q) => q.sql.includes("UPDATE $workspace"))).toBeUndefined();
  });

  test("returns workspace-not-found and does not open the workspace db when slug is missing", async () => {
    const state = createFakeDbState();
    const manager = createWorkspaceSettingsManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.renameWorkspace({ callerSubject: "admin-sub", slug: "ghost", name: "New" });

    expect(result).toEqual({ kind: "workspace-not-found" });
    expect(state.requestedSessions).toEqual(["_system"]);
    expect(state.queries.find((q) => q.sql.includes("UPDATE $workspace"))).toBeUndefined();
  });

  test("returns workspace-not-found and does not write when workspace is not active", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "archived", name: "Old" });
    const manager = createWorkspaceSettingsManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.renameWorkspace({ callerSubject: "admin-sub", slug: "acme", name: "New" });

    expect(result).toEqual({ kind: "workspace-not-found" });
    expect(state.requestedSessions).toEqual(["_system"]);
    expect(state.workspaces.get("acme")?.name).toBe("Old");
  });
});
