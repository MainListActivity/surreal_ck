import { describe, expect, test } from "bun:test";
import { LocalToRemoteWorker } from "./local-to-remote-worker";
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

describe("本地到远端同步 worker", () => {
  test("本地 workspace 更新成功推到远端后推进 cursor", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "vs1",
          update: {
            id: "workspace:ws1",
            name: "新名称",
            _origin_session_id: "local-session",
          },
          dirtyFields: ["name"],
        }]];
      }
      return [[]];
    });
    const remote = new FakeDb();

    const worker = new LocalToRemoteWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => true,
    });

    const result = await worker.runOnce();

    expect(result.pushed).toBe(1);
    expect(remote.queries[0]?.sql).toContain("UPDATE $record MERGE $content");
    expect(remote.queries[0]?.bindings).toMatchObject({
      record: "workspace:ws1",
      content: { name: "新名称" },
    });
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(true);
  });

  test("remote echo 变更会跳过推送但推进 cursor", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "vs2",
          update: {
            id: "workspace:ws1",
            name: "远端名称",
            _origin_session_id: "remote:vs1",
          },
          dirtyFields: ["name"],
        }]];
      }
      return [[]];
    });
    const remote = new FakeDb();

    const worker = new LocalToRemoteWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => true,
    });

    const result = await worker.runOnce();

    expect(result.skipped).toBe(1);
    expect(remote.queries).toHaveLength(0);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(true);
  });

  test("远端临时失败时不推进 cursor，下一轮可重试", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "vs3",
          update: {
            id: "workspace:ws1",
            name: "失败名称",
            _origin_session_id: "local-session",
          },
          dirtyFields: ["name"],
        }]];
      }
      return [[]];
    });
    const remote = new FakeDb(() => {
      throw new Error("network timeout");
    });

    const worker = new LocalToRemoteWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => true,
    });

    const result = await worker.runOnce();

    expect(result.pushed).toBe(0);
    expect(result.failed).toBe(1);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(false);
  });

  test("远端语义拒绝进入 dead-letter 并推进 cursor", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "vs-perm",
          update: {
            id: "workspace:ws1",
            name: "无权限名称",
            _origin_session_id: "local-session",
          },
          dirtyFields: ["name"],
        }]];
      }
      return [[]];
    });
    const remote = new FakeDb((sql) => {
      if (sql.includes("SELECT * FROM")) return [[]];
      throw new Error("PERMISSIONS: Not enough permissions");
    });

    const worker = new LocalToRemoteWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => true,
    });

    const result = await worker.runOnce();

    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(true);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(true);
  });

  test("sensitive=true 的 app_setting 行被过滤且 cursor 前进", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "vs4",
          update: {
            id: "app_setting:ai_provider",
            key: "ai.provider",
            sensitive: true,
            value: { apiKey: "secret" },
            _origin_session_id: "local-session",
          },
          dirtyFields: ["value", "sensitive"],
        }]];
      }
      return [[]];
    });
    const remote = new FakeDb();

    const worker = new LocalToRemoteWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["app_setting"],
      isOnline: () => true,
    });

    const result = await worker.runOnce();

    expect(result.skipped).toBe(1);
    expect(remote.queries).toHaveLength(0);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(true);
  });

  test("RELATION 表 create 使用 RELATE 而不是普通 UPSERT", async () => {
    const local = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "vs5",
          create: {
            id: "has_workspace_member:edge1",
            in: "workspace:ws1",
            out: "app_user:u1",
            role: "editor",
            _origin_session_id: "local-session",
          },
        }]];
      }
      return [[]];
    });
    const remote = new FakeDb();

    const worker = new LocalToRemoteWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["has_workspace_member"],
      isOnline: () => true,
    });

    await worker.runOnce();

    expect(remote.queries[0]?.sql).toContain("RELATE $in->has_workspace_member->$out CONTENT $content");
    expect(remote.queries[0]?.bindings).toMatchObject({
      in: "workspace:ws1",
      out: "app_user:u1",
      content: { role: "editor" },
    });
  });
});
