import { describe, expect, test } from "bun:test";
import { checkCursorHealthAndRebuild } from "./cursor-health";
import type { SyncDb, SyncQuery } from "./types";

function normalizeQuery(sql: SyncQuery, bindings?: Record<string, unknown>) {
  if (typeof sql === "string") return { sql, bindings };
  return { sql: sql.query, bindings: sql.bindings };
}

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  constructor(private readonly handler: (sql: string, bindings?: Record<string, unknown>) => unknown = () => []) {}

  async query<T = unknown>(sql: SyncQuery, bindings?: Record<string, unknown>): Promise<T> {
    const normalized = normalizeQuery(sql, bindings);
    this.queries.push(normalized);
    return this.handler(normalized.sql, normalized.bindings) as T;
  }
}

describe("cursor 健康检查", () => {
  test("健康检查使用 sync_cursor 保存的 versionstamp", async () => {
    const local = new FakeDb((sql, bindings) => {
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("local_to_remote__workspace")) {
        return [[{ versionstamp: "9" }]];
      }
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("remote_to_local__workspace")) {
        return [[{ versionstamp: "8" }]];
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
      query.sql.includes("SHOW CHANGES") && query.sql.includes("SINCE 9") && Object.keys(query.bindings ?? {}).length === 0,
    )).toBe(true);
    expect(remote.queries.some((query) =>
      query.sql.includes("SHOW CHANGES") && query.sql.includes("SINCE 8") && Object.keys(query.bindings ?? {}).length === 0,
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

  test("远端 SHOW CHANGES 权限不足时错误包含具体操作", async () => {
    const local = new FakeDb((sql, bindings) => {
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("local_to_remote__workspace")) {
        return [[{ versionstamp: "9" }]];
      }
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("remote_to_local__workspace")) {
        return [[{ versionstamp: "8" }]];
      }
      return [[]];
    });
    const remote = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        throw Object.assign(
          new Error("IAM error: Not enough permissions to perform this action"),
          { kind: "NotAllowed", code: 0 },
        );
      }
      return [[]];
    });

    await expect(checkCursorHealthAndRebuild({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
    })).rejects.toThrow(
      `remote changefeed health check table=workspace cursor=8 query="SHOW CHANGES FOR TABLE workspace SINCE 8": IAM error: Not enough permissions to perform this action`,
    );
  });
});
