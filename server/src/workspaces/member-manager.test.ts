import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import { createMemberManager, type MemberManagerSessionFactory } from "./member-manager";

type QueryCall = { sql: string; params?: Record<string, unknown>; database: string };

type FakeDbState = {
  queries: QueryCall[];
  requestedSessions: string[];
  // _system.workspace rows keyed by slug
  workspaces: Map<string, { id: string | RecordId | StringRecordId; dbName: string; status: string }>;
  // workspace db `user` rows: keyed by dbName, each a list of users
  workspaceUsers: Map<string, Array<{ id: string; subject: string | null; email: string; is_admin: boolean; kind: string; disabled_at: string | null }>>;
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

    // _system: resolve workspace by slug
    if (this.database === "_system" && normalized.includes("FROM workspace WHERE slug")) {
      const ws = this.state.workspaces.get(params?.slug as string);
      return [ws ? [{ id: ws.id, db_name: ws.dbName, status: ws.status }] : []];
    }

    // workspace db: caller admin check / roster read
    if (normalized.includes("FROM user WHERE") && normalized.includes("kind = 'human'")) {
      const users = this.state.workspaceUsers.get(this.database) ?? [];
      if (normalized.includes("subject = $callerSubject")) {
        return [users.filter((u) => u.subject === params?.callerSubject)];
      }
      if (normalized.includes("email = $email")) {
        return [users.filter((u) => u.email === params?.email)];
      }
      return [users];
    }

    // workspace db: read a single member by record id (PATCH/DELETE 定位目标)
    if (normalized.startsWith("SELECT") && normalized.includes("FROM $userRecord")) {
      const users = this.state.workspaceUsers.get(this.database) ?? [];
      const target = users.find((u) => recordIdMatches(u.id, params?.userRecord));
      return [target ? [{ id: target.id, email: target.email, kind: target.kind, is_admin: target.is_admin, disabled_at: target.disabled_at }] : []];
    }

    // workspace db: update a member's is_admin by record id
    if (normalized.startsWith("UPDATE $userRecord") && normalized.includes("is_admin")) {
      const users = this.state.workspaceUsers.get(this.database) ?? [];
      const target = users.find((u) => recordIdMatches(u.id, params?.userRecord));
      if (target) target.is_admin = params?.isAdmin === true;
      return [[]];
    }

    // workspace db: soft-remove a member by record id (write disabled_at, never DELETE)
    if (normalized.startsWith("UPDATE $userRecord") && normalized.includes("disabled_at")) {
      const users = this.state.workspaceUsers.get(this.database) ?? [];
      const target = users.find((u) => recordIdMatches(u.id, params?.userRecord));
      if (target) target.disabled_at = "2026-05-23T00:00:00Z";
      return [[]];
    }

    // _system: update index role by workspace + email
    if (this.database === "_system" && normalized.startsWith("UPDATE user_workspace_index") && normalized.includes("role")) {
      return [[]];
    }

    // _system: soft-remove index row by workspace + email
    if (this.database === "_system" && normalized.startsWith("UPDATE user_workspace_index") && normalized.includes("disabled_at")) {
      return [[]];
    }

    return [[]];
  }
}

function recordIdMatches(storedId: string, recordParam: unknown): boolean {
  if (recordParam === undefined || recordParam === null) return false;
  if (recordParam instanceof RecordId || recordParam instanceof StringRecordId) {
    return storedId === recordParam.toString();
  }
  return false;
}

function fakeSessionFactory(state: FakeDbState): MemberManagerSessionFactory {
  return async (database) => {
    state.requestedSessions.push(database);
    return new FakeDb(database, state);
  };
}

describe("MemberManager.addMember", () => {
  test("admin pre-creates a human member: writes ws db user and _system active index row", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.addMember({
      callerSubject: "admin-sub",
      slug: "acme",
      email: "newbie@example.test",
      displayName: "New Bie",
      isAdmin: false,
    });

    expect(result).toEqual({ kind: "added" });

    const userInsert = state.queries.find(
      (q) => q.database === "ws_acme" && q.sql.includes("INSERT INTO user") && q.params?.email === "newbie@example.test",
    );
    expect(userInsert).toBeDefined();
    expect(userInsert?.params?.isAdmin).toBe(false);

    const indexInsert = state.queries.find(
      (q) => q.database === "_system" && q.sql.includes("user_workspace_index") && q.params?.email === "newbie@example.test",
    );
    expect(indexInsert).toBeDefined();
    expect(indexInsert?.params?.role).toBe("participant");
    // workspace 字段是 record<workspace>，必须用 SurrealDB RecordId 值对象而非裸字符串。
    expect(indexInsert?.params?.workspace).toBeInstanceOf(StringRecordId);
    expect((indexInsert?.params?.workspace as StringRecordId).toString()).toBe("workspace:acme");
    expect(indexInsert?.params?.dbName).toBe("ws_acme");
  });

  test("uses SurrealDB value helpers when _system returns a RecordId object", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: new RecordId("workspace", "acme"), dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.addMember({
      callerSubject: "admin-sub",
      slug: "acme",
      email: "newbie@example.test",
      isAdmin: false,
    });

    expect(result).toEqual({ kind: "added" });

    const indexInsert = state.queries.find(
      (q) => q.database === "_system" && q.sql.includes("user_workspace_index") && q.params?.email === "newbie@example.test",
    );
    expect(indexInsert?.params?.workspace).toBeInstanceOf(StringRecordId);
    expect((indexInsert?.params?.workspace as StringRecordId).toString()).toBe("workspace:acme");
  });

  test("returns forbidden and writes nothing when the caller is not a workspace admin", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:member", subject: "member-sub", email: "member@example.test", is_admin: false, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.addMember({
      callerSubject: "member-sub",
      slug: "acme",
      email: "newbie@example.test",
      isAdmin: false,
    });

    expect(result).toEqual({ kind: "forbidden" });
    expect(state.queries.find((q) => q.sql.includes("INSERT INTO user"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("user_workspace_index"))).toBeUndefined();
  });

  test("returns workspace-not-found and writes nothing when the slug has no active workspace", async () => {
    const state = createFakeDbState();

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.addMember({
      callerSubject: "admin-sub",
      slug: "ghost",
      email: "newbie@example.test",
      isAdmin: false,
    });

    expect(result).toEqual({ kind: "workspace-not-found" });
    expect(state.queries.find((q) => q.sql.includes("INSERT INTO user"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("user_workspace_index"))).toBeUndefined();
  });
});

describe("MemberManager.updateMemberRole", () => {
  test("admin promotes a member: updates ws db user.is_admin and _system index.role together", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
      { id: "user:member", subject: "member-sub", email: "member@example.test", is_admin: false, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.updateMemberRole({
      callerSubject: "admin-sub",
      slug: "acme",
      userId: "member",
      isAdmin: true,
    });

    expect(result).toEqual({ kind: "updated" });

    const userUpdate = state.queries.find((q) => q.database === "ws_acme" && q.sql.includes("UPDATE $userRecord") && q.sql.includes("is_admin"));
    expect(userUpdate).toBeDefined();
    expect(userUpdate?.params?.isAdmin).toBe(true);

    const indexUpdate = state.queries.find((q) => q.database === "_system" && q.sql.includes("UPDATE user_workspace_index") && q.sql.includes("role"));
    expect(indexUpdate).toBeDefined();
    expect(indexUpdate?.params?.role).toBe("admin");
    expect(indexUpdate?.params?.email).toBe("member@example.test");
    expect((indexUpdate?.params?.workspace as StringRecordId).toString()).toBe("workspace:acme");

    // 状态校验：fake user.is_admin 已被改写
    expect(state.workspaceUsers.get("ws_acme")?.find((u) => u.id === "user:member")?.is_admin).toBe(true);
  });

  test("returns forbidden and writes nothing when the caller is not a workspace admin", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:member", subject: "member-sub", email: "member@example.test", is_admin: false, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.updateMemberRole({
      callerSubject: "member-sub",
      slug: "acme",
      userId: "member",
      isAdmin: true,
    });

    expect(result).toEqual({ kind: "forbidden" });
    expect(state.queries.find((q) => q.sql.includes("UPDATE $userRecord"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("UPDATE user_workspace_index"))).toBeUndefined();
  });

  test("returns member-not-found when the target user id does not exist in the workspace", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.updateMemberRole({
      callerSubject: "admin-sub",
      slug: "acme",
      userId: "ghost",
      isAdmin: true,
    });

    expect(result).toEqual({ kind: "member-not-found" });
    expect(state.queries.find((q) => q.sql.includes("UPDATE $userRecord"))).toBeUndefined();
    expect(state.queries.find((q) => q.sql.includes("UPDATE user_workspace_index"))).toBeUndefined();
  });
});

describe("MemberManager.removeMember", () => {
  test("admin soft-removes a member: writes disabled_at on ws db user and _system index, never DELETE", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
      { id: "user:member", subject: "member-sub", email: "member@example.test", is_admin: false, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.removeMember({
      callerSubject: "admin-sub",
      slug: "acme",
      userId: "member",
    });

    expect(result).toEqual({ kind: "removed" });

    const userDisable = state.queries.find((q) => q.database === "ws_acme" && q.sql.includes("UPDATE $userRecord") && q.sql.includes("disabled_at"));
    expect(userDisable).toBeDefined();

    const indexDisable = state.queries.find((q) => q.database === "_system" && q.sql.includes("UPDATE user_workspace_index") && q.sql.includes("disabled_at"));
    expect(indexDisable).toBeDefined();
    expect(indexDisable?.params?.email).toBe("member@example.test");
    expect((indexDisable?.params?.workspace as StringRecordId).toString()).toBe("workspace:acme");

    // 历史归因所需的 user record 不被删除
    expect(state.queries.find((q) => /\bDELETE\b/.test(q.sql))).toBeUndefined();
    expect(state.workspaceUsers.get("ws_acme")?.find((u) => u.id === "user:member")?.disabled_at).not.toBeNull();
  });

  test("returns forbidden and writes nothing when the caller is not a workspace admin", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:member", subject: "member-sub", email: "member@example.test", is_admin: false, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.removeMember({
      callerSubject: "member-sub",
      slug: "acme",
      userId: "member",
    });

    expect(result).toEqual({ kind: "forbidden" });
    expect(state.queries.find((q) => q.sql.includes("SET disabled_at"))).toBeUndefined();
  });

  test("returns member-not-found when the target user id does not exist", async () => {
    const state = createFakeDbState();
    state.workspaces.set("acme", { id: "workspace:acme", dbName: "ws_acme", status: "active" });
    state.workspaceUsers.set("ws_acme", [
      { id: "user:admin", subject: "admin-sub", email: "admin@example.test", is_admin: true, kind: "human", disabled_at: null },
    ]);

    const manager = createMemberManager({ getDbSession: fakeSessionFactory(state), namespace: "main" });

    const result = await manager.removeMember({
      callerSubject: "admin-sub",
      slug: "acme",
      userId: "ghost",
    });

    expect(result).toEqual({ kind: "member-not-found" });
    expect(state.queries.find((q) => q.sql.includes("SET disabled_at"))).toBeUndefined();
  });
});
