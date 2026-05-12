import { describe, expect, test } from "bun:test";
import { RemoteToLocalWorker } from "./remote-to-local-worker";
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

describe("远端到本地同步 worker", () => {
  test("远端 workspace 更新会 apply 到本地并推进 remote cursor", async () => {
    const remote = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "rvs1",
          update: { id: "workspace:ws1", name: "远端名称" },
          dirtyFields: ["name"],
        }]];
      }
      return [[]];
    });
    const local = new FakeDb();

    const worker = new RemoteToLocalWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => true,
    });

    const result = await worker.runOnce();

    expect(result.pulled).toBe(1);
    expect(local.queries.some((query) => query.sql.includes("UPDATE $record MERGE $content"))).toBe(true);
    expect(local.queries.find((query) => query.sql.includes("UPDATE $record"))?.bindings?.content)
      .toMatchObject({ name: "远端名称", _origin_session_id: "remote:rvs1" });
    expect(local.queries.some((query) => query.sql.includes("UPSERT $id"))).toBe(true);
  });

  test("远端 UPDATE 不覆盖同 record 的本地未推送字段", async () => {
    const remote = new FakeDb((sql) => {
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "rvs2",
          update: { id: "workspace:ws1", name: "远端名称", slug: "remote-slug" },
          dirtyFields: ["name", "slug"],
        }]];
      }
      return [[]];
    });
    const local = new FakeDb((sql, bindings) => {
      if (sql.includes("SELECT versionstamp") && String(bindings?.id).includes("local_to_remote__workspace")) {
        return [[{ versionstamp: "100" }]];
      }
      if (sql.includes("SHOW CHANGES")) {
        return [[{
          versionstamp: "lvs1",
          update: { id: "workspace:ws1", name: "本地未推送名称" },
          dirtyFields: ["name"],
        }]];
      }
      return [[]];
    });

    const worker = new RemoteToLocalWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => true,
    });

    await worker.runOnce();

    const applyQuery = local.queries.find((query) => query.sql.includes("UPDATE $record MERGE $content"));
    expect(applyQuery?.bindings?.content).toEqual({
      slug: "remote-slug",
      _origin_session_id: "remote:rvs2",
    });
  });

  test("离线时不查询远端", async () => {
    const remote = new FakeDb();
    const local = new FakeDb();
    const worker = new RemoteToLocalWorker({
      localDb: local,
      remoteDb: remote,
      tables: ["workspace"],
      isOnline: () => false,
    });

    const result = await worker.runOnce();

    expect(result.pulled).toBe(0);
    expect(remote.queries).toHaveLength(0);
    expect(local.queries).toHaveLength(0);
  });
});
