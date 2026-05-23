import { describe, expect, test } from "bun:test";
import type { WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { createWorkspaceCreator, type CreateWorkspaceClient, type CreateWorkspaceSessionFactory } from "./create-workspace";
import type { IdpTokenScopeAdapter } from "./idp-scope-adapter";
import type { SurrealTokenScope } from "./workspace-scope";

class FakeDb implements CreateWorkspaceClient {
  constructor(
    readonly database: string,
    private readonly state: FakeDbState,
  ) {}

  async query(sql: string, params?: Record<string, unknown>): Promise<any[]> {
    this.state.queries.push({ sql, params, database: this.database });
    const normalized = sql.trim().replace(/\s+/g, " ");

    if (this.state.failOn && this.database === this.state.failOn.database && normalized.includes(this.state.failOn.match)) {
      throw new Error("simulated query failure");
    }

    if (normalized.includes("FROM workspace WHERE slug")) {
      const slug = params?.slug;
      return [this.state.existingSlugs.has(slug as string) ? [{ id: "workspace:existing" }] : []];
    }

    if (normalized.includes("DEFINE DATABASE")) {
      const dbName = readDbNameFromDdl(normalized, "DEFINE DATABASE");
      if (dbName && this.state.physicalDbNames.has(dbName)) {
        throw new Error(`Database ${dbName} already exists`);
      }
      if (dbName) this.state.physicalDbNames.add(dbName);
    }

    if (normalized.includes("REMOVE DATABASE")) {
      const dbName = readDbNameFromDdl(normalized, "REMOVE DATABASE");
      if (dbName) this.state.physicalDbNames.delete(dbName);
    }

    if (this.database === "_system" && normalized.includes("BEGIN TRANSACTION")) {
      const slug = params?.slug as string | undefined;
      const dbName = params?.dbName as string | undefined;
      if (slug && this.state.existingSlugs.has(slug)) {
        throw new Error("workspace-slug-conflict");
      }
      if (dbName && this.state.existingDbNames.has(dbName)) {
        throw new Error("workspace-db-conflict");
      }
      if (slug) this.state.existingSlugs.add(slug);
      if (dbName) this.state.existingDbNames.add(dbName);
      this.state.systemWorkspaces.push({ slug: slug ?? "", dbName: dbName ?? "" });
    }

    return [[]];
  }
}

type FakeDbState = {
  queries: Array<{ sql: string; params?: Record<string, unknown>; database: string }>;
  requestedSessions: string[];
  existingSlugs: Set<string>;
  existingDbNames: Set<string>;
  physicalDbNames: Set<string>;
  systemWorkspaces: Array<{ slug: string; dbName: string }>;
  failOn?: { database: string; match: string };
};

function createFakeDbState(): FakeDbState {
  return {
    queries: [],
    requestedSessions: [],
    existingSlugs: new Set(),
    existingDbNames: new Set(),
    physicalDbNames: new Set(),
    systemWorkspaces: [],
  };
}

function fakeSessionFactory(state: FakeDbState): CreateWorkspaceSessionFactory {
  return async (database) => {
    state.requestedSessions.push(database);
    return new FakeDb(database, state);
  };
}

function readDbNameFromDdl(sql: string, prefix: "DEFINE DATABASE" | "REMOVE DATABASE"): string | null {
  const tail = sql.slice(sql.indexOf(prefix) + prefix.length).trim();
  return tail.match(/^([a-zA-Z0-9_]+)/)?.[1] ?? null;
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
  { version: 3, name: "003-tables-office.surql", sql: "DEFINE TABLE office_role SCHEMAFULL;" },
];

describe("createWorkspace lifecycle", () => {
  test("provisions db, applies template, seeds owner user and _system index, then updates IdP scope", async () => {
    const db = createFakeDbState();
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
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

    const defineDb = db.queries.find((q) => q.sql.includes("DEFINE DATABASE") && q.sql.includes("ws_abcdef123456"));
    expect(defineDb).toBeDefined();
    expect(defineDb?.sql).not.toContain("IF NOT EXISTS");

    const templateApplied = db.queries.filter((q) => q.database === "ws_abcdef123456" && q.sql.includes("DEFINE"));
    expect(templateApplied.length).toBeGreaterThanOrEqual(3);
    const versionWrite = db.queries.find(
      (q) => q.database === "ws_abcdef123456" && q.sql.includes("UPSERT schema_version:current"),
    );
    expect(versionWrite?.params?.version).toBe(3);

    const ownerInsert = db.queries.find((q) => q.database === "ws_abcdef123456" && q.sql.includes("user") && q.sql.includes("INSERT"));
    expect(ownerInsert).toBeDefined();
    expect(ownerInsert?.params?.subject).toBe("user-123");
    expect(ownerInsert?.params?.email).toBe("ada@example.test");

    const systemWrite = db.queries.find(
      (q) =>
        q.database === "_system" &&
        q.sql.includes("BEGIN TRANSACTION") &&
        q.sql.includes("CREATE ONLY workspace") &&
        q.sql.includes("user_workspace_index"),
    );
    expect(systemWrite).toBeDefined();
    expect(systemWrite?.params?.role).toBe("admin");

    expect(calls).toEqual([{ subject: "user-123", scope: { db: "ws_abcdef123456", ac: "admin" } }]);
    expect(db.requestedSessions).toContain("_system");
    expect(db.requestedSessions).toContain("ws_abcdef123456");
  });

  test("returns slug-conflict and never creates a database when slug already exists", async () => {
    const db = createFakeDbState();
    db.existingSlugs.add("acme");
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
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
    const db = createFakeDbState();
    db.failOn = { database: "ws_abcdef123456", match: "DEFINE TABLE user" };
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
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

    const dropQuery = db.queries.find((q) => q.sql.includes("REMOVE DATABASE") && q.sql.includes("ws_abcdef123456"));
    expect(dropQuery).toBeDefined();
    expect(dropQuery?.database).toBe("_system");
    expect(db.queries.find((q) => q.sql.includes("CREATE ONLY workspace"))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("does not drop a pre-existing physical database when generated db name collides", async () => {
    const db = createFakeDbState();
    db.physicalDbNames.add("ws_abcdef123456");
    const { adapter, calls } = recordingIdpAdapter();
    const ids = ["abcdef123456", "fedcba654321"];

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      generateId: () => ids.shift() ?? "unused",
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
      dbName: "ws_fedcba654321",
      refreshRequired: true,
    });
    expect(
      db.queries.find((q) => q.sql.includes("REMOVE DATABASE") && q.sql.includes("ws_abcdef123456")),
    ).toBeUndefined();
    expect(calls).toEqual([{ subject: "user-123", scope: { db: "ws_fedcba654321", ac: "admin" } }]);
  });

  test("rolls back _system workspace and drops the new database when membership index write fails", async () => {
    const db = createFakeDbState();
    db.failOn = { database: "_system", match: "user_workspace_index" };
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
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
    ).rejects.toThrow(/_system write failed/);

    expect(db.systemWorkspaces).toEqual([]);
    const dropQuery = db.queries.find((q) => q.sql.includes("REMOVE DATABASE") && q.sql.includes("ws_abcdef123456"));
    expect(dropQuery).toBeDefined();
    expect(calls).toEqual([]);
  });

  test("returns scope-update-failed and keeps the database when IdP scope update fails", async () => {
    const db = createFakeDbState();
    const failingAdapter: IdpTokenScopeAdapter = {
      async updateUserScope() {
        throw new Error("idp unreachable");
      },
    };

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
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
    expect(db.queries.find((q) => q.sql.includes("CREATE ONLY workspace"))).toBeDefined();
    expect(db.queries.find((q) => q.sql.includes("REMOVE DATABASE"))).toBeUndefined();
  });
});
