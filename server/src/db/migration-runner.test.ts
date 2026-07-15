import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, type WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAllWorkspaces } from "./migration-runner";

type QueryCall = {
  sql: string;
  params?: Record<string, unknown>;
};

type WorkspaceFixture = {
  dbName: string;
  schemaVersion: number;
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
      return [this.workspaces.map((workspace) => ({ db_name: workspace.dbName }))];
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
      const db = new FakeMigrationClient([{ dbName: "ws_behind", schemaVersion: 2 }]);

      const result = await migrateAllWorkspaces(db, {
        namespace: "main",
        loadScripts: () => loadTemplateScripts({ migrationsDir }),
      });

      expect(result.migrated).toEqual([{ dbName: "ws_behind", fromVersion: 2, toVersion: 3 }]);
      const appliedScripts = db.queryCalls
        .map((call) => call.sql.trim())
        .filter((sql) => sql.startsWith("--"));
      expect(appliedScripts).toEqual(["-- newly added fixture"]);
    } finally {
      await rm(migrationsDir, { recursive: true });
    }
  });

  test("migrates a workspace db that is behind up to the latest template version", async () => {
    const db = new FakeMigrationClient([{ dbName: "ws_behind", schemaVersion: 1 }]);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      loadScripts: async () => fakeScripts(1, 2, 3),
    });

    expect(result.total).toBe(1);
    expect(result.migrated).toEqual([{ dbName: "ws_behind", fromVersion: 1, toVersion: 3 }]);

    expect(db.useCalls).toEqual([
      { namespace: "main", database: "_system" },
      { namespace: "main", database: "ws_behind" },
    ]);

    const wsCalls = db.queryCalls.filter((call) => call.sql.includes("migration") || call.sql.includes("UPSERT"));
    expect(wsCalls.map((call) => call.sql.trim())).toEqual([
      "-- migration 2",
      "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
      "-- migration 3",
      "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
    ]);
  });

  test("does not reapply templates to a workspace db already at the latest version", async () => {
    const db = new FakeMigrationClient([{ dbName: "ws_current", schemaVersion: 3 }]);

    const result = await migrateAllWorkspaces(db, {
      namespace: "main",
      loadScripts: async () => fakeScripts(1, 2, 3),
    });

    expect(result).toEqual({ total: 1, migrated: [] });

    const wsCalls = db.queryCalls.filter((call) => call.sql.includes("migration") || call.sql.includes("UPSERT"));
    expect(wsCalls).toEqual([]);
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

  test("fails fast when a workspace db throws, keeping already-migrated dbs and reporting progress", async () => {
    const workspaces: WorkspaceFixture[] = [
      { dbName: "ws_ok", schemaVersion: 1 },
      { dbName: "ws_broken", schemaVersion: 1 },
      { dbName: "ws_untouched", schemaVersion: 1 },
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

    // 整体抛错（fail-fast）
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("ws_broken");
    expect(message).toContain("1/3"); // 失败前已成功 1 个，共 3 个

    // 已成功迁的 db 不回滚
    expect(workspaces.find((entry) => entry.dbName === "ws_ok")?.schemaVersion).toBe(3);
    // 失败的 db 没有写入版本（中途抛错）
    expect(workspaces.find((entry) => entry.dbName === "ws_broken")?.schemaVersion).toBe(1);
    // 失败后停止，第三个 db 从未被 USE
    expect(db.useCalls.some((call) => call.database === "ws_untouched")).toBe(false);
  });
});
