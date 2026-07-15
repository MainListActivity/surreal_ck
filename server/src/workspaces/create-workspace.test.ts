import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, type WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import type { TemplatePackScript } from "@surreal-ck/shared/template-packs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceCreator, type CreateWorkspaceClient, type CreateWorkspaceSessionFactory } from "./create-workspace";
import { closeRootConnection, getRootConnection, initRootConnection } from "../db/root-connection";
import { ensureSystemSchema } from "../db/system-schema";
import { env, overrideEnv } from "../env";
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

function recordingIdpAdapter(): { adapter: IdpTokenScopeAdapter; calls: Array<{ subjectToken: string; scope: SurrealTokenScope }> } {
  const calls: Array<{ subjectToken: string; scope: SurrealTokenScope }> = [];
  return {
    calls,
    adapter: {
      async updateUserScope(input) {
        calls.push(input);
        return { accessToken: "scoped-token", expiresIn: 3600 };
      },
    },
  };
}

const templateScripts: WorkspaceTemplateScript[] = [
  { version: 1, name: "001-access.surql", sql: "DEFINE ACCESS admin ON DATABASE TYPE JWT URL 'x';" },
  { version: 2, name: "002-tables-core.surql", sql: "DEFINE TABLE user SCHEMAFULL;" },
  { version: 3, name: "003-tables-office.surql", sql: "DEFINE TABLE office_role SCHEMAFULL;" },
];

const selectedTemplatePacks: TemplatePackScript[] = [
  {
    name: "test-pack",
    fileName: "test-pack.surql",
    sql: 'INSERT INTO workbook_template { key: "test-pack" };',
  },
];

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");

function localSurrealConfig() {
  return {
    url: process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc",
    namespace: process.env.LOCAL_SURREAL_NS ?? "main",
    username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
    password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
  };
}

async function withTimeout<T>(work: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("createWorkspace lifecycle", () => {
  test("新工作区会应用加载器自动发现的完整 SurQL 脚本集合", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "surreal-ck-create-workspace-"));
    try {
      await writeFile(join(migrationsDir, "001-base.surql"), "-- base migration", "utf8");
      await writeFile(join(migrationsDir, "002-existing.surql"), "-- existing migration", "utf8");
      await writeFile(join(migrationsDir, "003-auto-discovered.surql"), "-- newly added fixture", "utf8");
      const db = createFakeDbState();
      const { adapter } = recordingIdpAdapter();
      const creator = createWorkspaceCreator({
        getDbSession: fakeSessionFactory(db),
        idpTokenScopeAdapter: adapter,
        loadTemplateScripts: () => loadTemplateScripts({ migrationsDir }),
        generateId: () => "abcdef123456",
        namespace: "main",
      });

      await creator.createWorkspace({
        subject: "user-123",
        subjectToken: "subject-token",
        email: "ada@example.test",
        name: "Acme Legal",
        slug: "acme",
      });

      const workspaceQueries = db.queries
        .filter((query) => query.database === "ws_abcdef123456")
        .map((query) => query.sql.trim());
      expect(workspaceQueries.slice(0, 3)).toEqual([
        "-- base migration",
        "-- existing migration",
        "-- newly added fixture",
      ]);
      expect(
        db.queries.find(
          (query) => query.database === "ws_abcdef123456" && query.sql.includes("UPSERT schema_version:current"),
        )?.params?.version,
      ).toBe(3);
    } finally {
      await rm(migrationsDir, { recursive: true });
    }
  });

  test("通用 schema 完成后播种部署选择的模板包", async () => {
    const db = createFakeDbState();
    const { adapter } = recordingIdpAdapter();
    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      loadTemplatePackScripts: async () => selectedTemplatePacks,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    await creator.createWorkspace({
      subject: "user-123",
      subjectToken: "subject-token",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    const workspaceQueries = db.queries
      .filter((query) => query.database === "ws_abcdef123456")
      .map((query) => query.sql);
    expect(workspaceQueries.indexOf(selectedTemplatePacks[0]!.sql)).toBeGreaterThan(
      workspaceQueries.indexOf(templateScripts.at(-1)!.sql),
    );
  });

  test("模板包加载失败时补偿删除新建 database", async () => {
    const db = createFakeDbState();
    const { adapter, calls } = recordingIdpAdapter();
    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      loadTemplatePackScripts: async () => {
        throw new Error("unknown template pack: missing-pack");
      },
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    await expect(
      creator.createWorkspace({
        subject: "user-123",
        subjectToken: "subject-token",
        email: "ada@example.test",
        name: "Acme Legal",
        slug: "acme",
      }),
    ).rejects.toThrow(/template apply failed/);

    expect(db.queries.some((query) => query.sql.includes("REMOVE DATABASE") && query.sql.includes("ws_abcdef123456"))).toBe(true);
    expect(db.queries.some((query) => query.sql.includes("CREATE ONLY workspace"))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("模板包 SurQL 执行失败时补偿删除新建 database", async () => {
    const db = createFakeDbState();
    db.failOn = { database: "ws_abcdef123456", match: "INSERT INTO workbook_template" };
    const { adapter, calls } = recordingIdpAdapter();
    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(db),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      loadTemplatePackScripts: async () => selectedTemplatePacks,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    await expect(
      creator.createWorkspace({
        subject: "user-123",
        subjectToken: "subject-token",
        email: "ada@example.test",
        name: "Acme Legal",
        slug: "acme",
      }),
    ).rejects.toThrow(/template apply failed/);

    expect(db.queries.some((query) => query.sql.includes("REMOVE DATABASE") && query.sql.includes("ws_abcdef123456"))).toBe(true);
    expect(db.queries.some((query) => query.sql.includes("CREATE ONLY workspace"))).toBe(false);
    expect(calls).toEqual([]);
  });

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
      subjectToken: "subject-token",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    expect(result).toEqual({
      kind: "created",
      slug: "acme",
      dbName: "ws_abcdef123456",
      accessToken: "scoped-token",
      expiresIn: 3600,
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

    expect(calls).toEqual([{ subjectToken: "subject-token", scope: { db: "ws_abcdef123456", ac: "admin" } }]);
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
      subjectToken: "subject-token",
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
        subjectToken: "subject-token",
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
      subjectToken: "subject-token",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    expect(result).toEqual({
      kind: "created",
      slug: "acme",
      dbName: "ws_fedcba654321",
      accessToken: "scoped-token",
      expiresIn: 3600,
    });
    expect(
      db.queries.find((q) => q.sql.includes("REMOVE DATABASE") && q.sql.includes("ws_abcdef123456")),
    ).toBeUndefined();
    expect(calls).toEqual([{ subjectToken: "subject-token", scope: { db: "ws_fedcba654321", ac: "admin" } }]);
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
        subjectToken: "subject-token",
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
      subjectToken: "subject-token",
      email: "ada@example.test",
      name: "Acme Legal",
      slug: "acme",
    });

    expect(result).toEqual({ kind: "scope-update-failed", slug: "acme", dbName: "ws_abcdef123456" });
    expect(db.queries.find((q) => q.sql.includes("CREATE ONLY workspace"))).toBeDefined();
    expect(db.queries.find((q) => q.sql.includes("REMOVE DATABASE"))).toBeUndefined();
  });
});

describe("createWorkspace lifecycle against local SurrealDB", () => {
  localSurrealTest(
    "defines a workspace database from the _system session",
    async () => {
      const config = localSurrealConfig();
      const previousEnv = { ...env };
      const id = Date.now().toString(36);
      const dbName = `ws_codex_${id}`;
      const slug = `codex-${id}`;

      try {
        overrideEnv({
          SURREAL_URL: config.url,
          SURREAL_NS: config.namespace,
          SURREAL_ROOT_USER: config.username,
          SURREAL_ROOT_PASS: config.password,
        });
        await withTimeout(initRootConnection(), "connect local SurrealDB");
        await withTimeout(
          ensureSystemSchema(getRootConnection(), { namespace: config.namespace }),
          "ensure _system schema",
        );

        const creator = createWorkspaceCreator({
          idpTokenScopeAdapter: {
            async updateUserScope() {
              // The local integration test only verifies SurrealDB lifecycle behavior.
              return { accessToken: "scoped-token", expiresIn: 3600 };
            },
          },
          loadTemplateScripts: async () => [],
          generateId: () => dbName.slice("ws_".length),
          namespace: config.namespace,
        });

        const result = await creator.createWorkspace({
          subject: `user-${id}`,
          subjectToken: "subject-token",
          email: `user-${id}@example.test`,
          name: "Codex Local SurrealDB Probe",
          slug,
        });

        expect(result).toEqual({
          kind: "created",
          slug,
          dbName,
          accessToken: "scoped-token",
          expiresIn: 3600,
        });

        const root = getRootConnection();
        await root.use({ namespace: config.namespace, database: dbName });
        const [currentDb] = await withTimeout(
          root.query<[string]>("RETURN $dbName;", { dbName }),
          "read created database",
        );
        expect(currentDb).toBe(dbName);
      } finally {
        try {
          const root = getRootConnection();
          await root.use({ namespace: config.namespace, database: "_system" }).catch(() => undefined);
          await root
            .query("DELETE workspace WHERE db_name = $dbName; DELETE user_workspace_index WHERE db_name = $dbName;", {
              dbName,
            })
            .catch(() => undefined);
          await root.query(`REMOVE DATABASE ${dbName};`).catch(() => undefined);
        } catch {
          // The connection may not have initialized if the opt-in local service is unavailable.
        }

        await closeRootConnection();
        overrideEnv(previousEnv);
      }
    },
    15_000,
  );
});
