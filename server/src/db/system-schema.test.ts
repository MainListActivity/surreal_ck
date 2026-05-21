import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { ensureSystemSchema } from "./system-schema";

type QueryCall = {
  sql: string;
  params?: Record<string, unknown>;
};

class FakeSystemSchemaClient {
  readonly useCalls: Array<{ namespace: string; database: string }> = [];
  readonly queryCalls: QueryCall[] = [];
  currentVersion = 0;

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<unknown[]> {
    this.queryCalls.push({ sql, params });

    if (sql.includes("SELECT") && sql.includes("_system_schema_version:current")) {
      return [[{ version: this.currentVersion }]];
    }

    if (sql.includes("UPSERT _system_schema_version:current")) {
      this.currentVersion = Number(params?.version ?? 0);
      return [[]];
    }

    return [[]];
  }
}

let tempDir: string | undefined;

async function createMigrations(files: Record<string, string>): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "surreal-ck-system-sql-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(tempDir, name), content, "utf8");
  }
  return tempDir;
}

describe("system schema seed", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("applies pending system migrations in version order and records the current version", async () => {
    const migrationsDir = await createMigrations({
      "002-second.surql": "-- second migration",
      "001-init.surql": "-- first migration",
    });
    const db = new FakeSystemSchemaClient();

    const result = await ensureSystemSchema(db, { migrationsDir, namespace: "main" });

    expect(result).toEqual({ fromVersion: 0, toVersion: 2, appliedVersions: [1, 2] });
    expect(db.useCalls).toEqual([{ namespace: "main", database: "_system" }]);
    expect(db.queryCalls.map((call) => call.sql.trim())).toEqual([
      "DEFINE DATABASE IF NOT EXISTS _system;",
      "SELECT version FROM _system_schema_version:current;",
      "-- first migration",
      "UPSERT _system_schema_version:current CONTENT { version: $version, applied_at: time::now() };",
      "-- second migration",
      "UPSERT _system_schema_version:current CONTENT { version: $version, applied_at: time::now() };",
    ]);
  });

  test("does not reapply migrations when the current version is already up to date", async () => {
    const migrationsDir = await createMigrations({
      "001-init.surql": "-- first migration",
    });
    const db = new FakeSystemSchemaClient();
    db.currentVersion = 1;

    const result = await ensureSystemSchema(db, { migrationsDir, namespace: "main" });

    expect(result).toEqual({ fromVersion: 1, toVersion: 1, appliedVersions: [] });
    expect(db.queryCalls.map((call) => call.sql.trim())).toEqual([
      "DEFINE DATABASE IF NOT EXISTS _system;",
      "SELECT version FROM _system_schema_version:current;",
    ]);
  });
});
