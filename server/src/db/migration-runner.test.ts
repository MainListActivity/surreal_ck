import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, type WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { NATIVE_QUOTA_EXPECTED_CONTRACT } from "@surreal-ck/shared/native-quota";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAllWorkspaces } from "./migration-runner";

type QueryCall = {
  sql: string;
  params?: Record<string, unknown>;
};

type WorkspaceFixture = {
  id: string;
  dbName: string;
  schemaVersion: number;
  quotaMigrationState?: string;
  legacyCleanupAfter?: string;
  lastMigrationError?: string | null;
  lastMigrationVersion?: number | null;
};

class FakeMigrationClient {
  readonly useCalls: Array<{ namespace: string; database: string }> = [];
  readonly queryCalls: QueryCall[] = [];
  currentDatabase = "_system";

  constructor(
    private readonly workspaces: WorkspaceFixture[],
    private readonly failOnDb?: string,
  ) {}

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
    this.currentDatabase = scope.database;
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<unknown[]> {
    this.queryCalls.push({ sql, params });

    if (sql.includes("SELECT") && sql.includes("FROM workspace")) {
      return [
        this.workspaces.map((workspace) => ({
          id: workspace.id,
          db_name: workspace.dbName,
          quota_migration_state: workspace.quotaMigrationState ?? "not_started",
          legacy_cleanup_after: workspace.legacyCleanupAfter,
        })),
      ];
    }

    if (sql.includes("SELECT") && sql.includes("schema_version:current")) {
      const workspace = this.workspaces.find((entry) => entry.dbName === this.currentDatabase);
      return [[{ version: workspace?.schemaVersion ?? 0 }]];
    }

    if (sql.includes("migration") && this.currentDatabase === this.failOnDb) {
      throw new Error(`forced failure while migrating ${this.currentDatabase}`);
    }

    if (sql.includes("UPSERT schema_version:current")) {
      const workspace = this.workspaces.find((entry) => entry.dbName === this.currentDatabase);
      if (workspace) workspace.schemaVersion = Number(params?.version ?? 0);
      return [[]];
    }

    if (sql.includes("UPDATE $workspace SET") || sql.includes("UPDATE $workspace SET")) {
      const workspace = this.workspaces.find((entry) => entry.id === params?.workspace);
      if (workspace) {
        if (params?.version !== undefined && params?.version !== null) {
          workspace.lastMigrationVersion = Number(params.version);
        }
        if ("error" in (params ?? {})) {
          workspace.lastMigrationError = (params?.error as string | null) ?? null;
        }
        if (params?.quotaMigrationState === "cleanup_done") {
          workspace.quotaMigrationState = "cleanup_done";
        }
      }
      return [[]];
    }

    return [[]];
  }
}

function fakeScripts(...versions: number[]): WorkspaceTemplateScript[] {
  return versions.map((version) => ({
    version,
    name: `${String(version).padStart(3, "0")}-fixture.surql`,
    sql: `-- migration ${version}`,
  }));
}

describe("workspace migration runner", () => {
  test("已有工作区只应用加载器自动发现的更高版本 SurQL 脚本", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "surreal-ck-migrate-workspace-"));
    try {
      await writeFile(join(migrationsDir, "001-base.surql"), "-- base migration", "utf8");
      await writeFile(join(migrationsDir, "002-existing.surql"), "-- existing migration", "utf8");
      await writeFile(join(migrationsDir, "003-auto-discovered.surql"), "-- newly added fixture", "utf8");
      const db = new FakeMigrationClient([
        { id: "workspace:behind", dbName: "ws_behind", schemaVersion: 2 },
      ]);

      const result = await migrateAllWorkspaces(db, {
        namespace: "main",
        loadScripts: () => loadTemplateScripts({ migrationsDir }),
      });

      expect(result.migrated).toEqual([
        { dbName: "ws_behind", fromVersion: 2, toVersion: 3 },
      ]);
      const appliedScripts = db.queryCalls
        .map((call) => call.sql.trim())
        .filter((sql) => sql.startsWith("--"));
      expect(appliedScripts).toEqual(["-- newly added fixture"]);
    } finally {
      await rm(migrationsDir, { recursive: true });
    }
  });

  test("migrates a workspace db that is behind up to the latest template version", async () => {
    const db = new FakeMigrationClient([
      { id: "workspace:behind", dbName: "ws_behind", schemaVersion: 1 },
    ]);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      loadScripts: async () => fakeScripts(1, 2, 3),
    });

    expect(result.total).toBe(1);
    expect(result.migrated).toEqual([{ dbName: "ws_behind", fromVersion: 1, toVersion: 3 }]);

    expect(db.useCalls[0]).toEqual({ namespace: "main", database: "_system" });
    expect(db.useCalls).toContainEqual({ namespace: "main", database: "ws_behind" });
    expect(db.useCalls.at(-1)).toEqual({ namespace: "main", database: "_system" });

    const migrationSql = db.queryCalls
      .map((call) => call.sql.trim())
      .filter((sql) => sql.startsWith("-- migration") || sql.startsWith("UPSERT schema_version"));
    expect(migrationSql).toEqual([
      "-- migration 2",
      "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
      "-- migration 3",
      "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
    ]);
  });

  test("does not reapply templates to a workspace db already at the latest version", async () => {
    const db = new FakeMigrationClient([
      { id: "workspace:current", dbName: "ws_current", schemaVersion: 3 },
    ]);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      loadScripts: async () => fakeScripts(1, 2, 3),
    });

    expect(result).toEqual({ total: 1, migrated: [] });

    const migrationSql = db.queryCalls
      .map((call) => call.sql.trim())
      .filter((sql) => sql.startsWith("-- migration") || sql.startsWith("UPSERT schema_version"));
    expect(migrationSql).toEqual([]);
  });

  test("不再在 version>=20 时重装动态 quota events", async () => {
    const db = new FakeMigrationClient([
      { id: "workspace:quota", dbName: "ws_quota", schemaVersion: 20 },
    ]);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      loadScripts: async () => fakeScripts(...Array.from({ length: 20 }, (_, index) => index + 1)),
    });

    expect(result).toEqual({ total: 1, migrated: [] });
    expect(
      db.queryCalls.some((call) => call.sql.includes("install") || call.sql.includes("sheet_resource")),
    ).toBe(false);
  });

  test("legacy cleanup stays blocked at native_policy_active and does not advance version", async () => {
    const workspaces: WorkspaceFixture[] = [
      {
        id: "workspace:legacy",
        dbName: "ws_legacy",
        schemaVersion: 20,
        quotaMigrationState: "native_policy_active",
      },
    ];
    const db = new FakeMigrationClient(workspaces);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
      loadScripts: async () => fakeScripts(...Array.from({ length: 21 }, (_, index) => index + 1)),
    });

    expect(result.migrated).toEqual([
      {
        dbName: "ws_legacy",
        fromVersion: 20,
        toVersion: 20,
        blockedVersion: 21,
        blockedReason: "quota_migration_state",
      },
    ]);
    expect(workspaces[0]?.schemaVersion).toBe(20);
    expect(
      db.queryCalls.some((call) => call.sql.includes("-- migration 21")),
    ).toBe(false);
  });

  test("legacy cleanup stays blocked during the rollback stability window", async () => {
    const workspaces: WorkspaceFixture[] = [
      {
        id: "workspace:waiting",
        dbName: "ws_waiting",
        schemaVersion: 20,
        quotaMigrationState: "native_verified",
        legacyCleanupAfter: "2026-08-26T00:00:00.000Z",
      },
    ];
    const db = new FakeMigrationClient(workspaces);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      now: new Date("2026-07-27T00:00:00.000Z"),
      engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
      loadScripts: async () => fakeScripts(...Array.from({ length: 21 }, (_, index) => index + 1)),
    });

    expect(result.migrated[0]).toMatchObject({
      dbName: "ws_waiting",
      fromVersion: 20,
      toVersion: 20,
      blockedVersion: 21,
      blockedReason: "legacy_cleanup_window",
    });
    expect(workspaces[0]?.schemaVersion).toBe(20);
  });

  test("legacy cleanup runs after the persisted stability window and marks cleanup_done", async () => {
    const workspaces: WorkspaceFixture[] = [
      {
        id: "workspace:ready",
        dbName: "ws_ready",
        schemaVersion: 20,
        quotaMigrationState: "native_verified",
        legacyCleanupAfter: "2026-07-26T00:00:00.000Z",
      },
    ];
    const db = new FakeMigrationClient(workspaces);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      now: new Date("2026-07-27T00:00:00.000Z"),
      engineCapabilities: [NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName],
      loadScripts: async () => fakeScripts(...Array.from({ length: 21 }, (_, index) => index + 1)),
    });

    expect(result.migrated[0]?.toVersion).toBe(21);
    expect(workspaces[0]?.schemaVersion).toBe(21);
    expect(
      db.queryCalls.some((call) =>
        call.sql.includes(
          "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE sheet",
        )
      ),
    ).toBe(true);
  });

  test("returns immediately without loading templates when there are no workspaces", async () => {
    const db = new FakeMigrationClient([]);
    let loadScriptsCalls = 0;

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      loadScripts: async () => {
        loadScriptsCalls += 1;
        return fakeScripts(1, 2, 3);
      },
    });

    expect(result).toEqual({ total: 0, migrated: [] });
    expect(loadScriptsCalls).toBe(0);
    expect(db.useCalls).toEqual([{ namespace: "main", database: "_system" }]);
  });

  test("fails fast when a workspace db throws, keeps progress and writes error to _system", async () => {
    const workspaces: WorkspaceFixture[] = [
      { id: "workspace:ok", dbName: "ws_ok", schemaVersion: 1 },
      { id: "workspace:broken", dbName: "ws_broken", schemaVersion: 1 },
      { id: "workspace:untouched", dbName: "ws_untouched", schemaVersion: 1 },
    ];
    const db = new FakeMigrationClient(workspaces, "ws_broken");

    let thrown: unknown;
    try {
      await migrateAllWorkspaces(db, {
        namespace: "main",
        loadScripts: async () => fakeScripts(1, 2, 3),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("ws_broken");
    expect(message).toContain("1/3");

    expect(workspaces.find((entry) => entry.dbName === "ws_ok")?.schemaVersion).toBe(3);
    expect(workspaces.find((entry) => entry.dbName === "ws_broken")?.schemaVersion).toBe(1);
    expect(db.useCalls.some((call) => call.database === "ws_untouched")).toBe(false);
    expect(
      db.queryCalls.some(
        (call) =>
          call.sql.includes("last_migration_error")
          && call.params?.workspace === "workspace:broken",
      ),
    ).toBe(true);
  });
});
