import { describe, expect, test } from "bun:test";
import { ensurePlatformContentSchema } from "./schema";

class FakeSchemaClient {
  currentVersion = 0;
  readonly useCalls: Array<{ namespace: string; database: string }> = [];
  readonly queryCalls: Array<{ sql: string; params?: Record<string, unknown> }> = [];

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.useCalls.push(scope);
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<unknown> {
    this.queryCalls.push({ sql, params });
    if (sql.includes("SELECT version")) return [[{ version: this.currentVersion }]];
    if (sql.includes("UPSERT platform_content_schema_version")) this.currentVersion = Number(params?.version ?? 0);
    return [[]];
  }
}

describe("platform content schema migration", () => {
  test("applies only pending scripts and is idempotent", async () => {
    const db = new FakeSchemaClient();
    const scripts = [
      { version: 1, name: "001-one.surql", sql: "-- one" },
      { version: 2, name: "002-two.surql", sql: "-- two" },
    ];
    const first = await ensurePlatformContentSchema(db, {
      namespace: "main",
      loadScripts: async () => scripts,
    });
    expect(first).toEqual({ fromVersion: 0, toVersion: 2, appliedVersions: [1, 2] });
    expect(db.useCalls).toEqual([{ namespace: "main", database: "_system" }]);
    const second = await ensurePlatformContentSchema(db, {
      namespace: "main",
      loadScripts: async () => scripts,
    });
    expect(second).toEqual({ fromVersion: 2, toVersion: 2, appliedVersions: [] });
  });
});
