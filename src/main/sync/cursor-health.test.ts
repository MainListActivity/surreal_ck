import { describe, expect, test } from "bun:test";
import { checkCursorHealthAndRebuild } from "./cursor-health";
import type { SyncDb } from "./types";

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  constructor(private readonly handler: (sql: string, bindings?: Record<string, unknown>) => unknown = () => []) {}

  async query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> {
    this.queries.push({ sql, bindings });
    return this.handler(sql, bindings) as T;
  }
}

describe("cursor 健康检查", () => {
  test("健康检查使用 sync_cursor 保存的 versionstamp", async () => {
    const local = new FakeDb((sql, bindings) => {
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("local_to_remote__workspace")) {
        return [[{ versionstamp: "local-vs9" }]];
      }
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("remote_to_local__workspace")) {
        return [[{ versionstamp: "remote-vs8" }]];
      }
      return [[]];
    });
    const remote = new FakeDb();

    await checkCursorHealthAndRebuild({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
    });

    expect(local.queries.some((query) =>
      query.sql.includes("SHOW CHANGES") && query.bindings?.cursor === "local-vs9",
    )).toBe(true);
    expect(remote.queries.some((query) =>
      query.sql.includes("SHOW CHANGES") && query.bindings?.cursor === "remote-vs8",
    )).toBe(true);
  });

  test("本地 cursor too old 标记 stale 但不抛错", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) throw new Error("cursor too old");
      return [[]];
    });
    const remote = new FakeDb();

    const result = await checkCursorHealthAndRebuild({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
    });

    expect(result.localChangefeedStale).toBe(true);
    expect(result.rebuilt).toBe(false);
  });

  test("远端 cursor too old 触发全量重建", async () => {
    const local = new FakeDb();
    const remote = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) throw new Error("cursor too old");
      if (sql.includes("SELECT * FROM")) {
        return [[{ id: "workspace:ws1", name: "远端空间" }]];
      }
      return [[]];
    });

    const result = await checkCursorHealthAndRebuild({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
    });

    expect(result.rebuilt).toBe(true);
    expect(local.queries.some((query) => query.sql.includes("DELETE FROM type::table($table)"))).toBe(true);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $record CONTENT $content"))).toBe(true);
  });
});
