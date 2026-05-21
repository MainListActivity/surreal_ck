import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startSyncWorkers, stopSyncWorkers } from "./manager";
import {
  getSyncRuntimeState,
  markDirtyProjectionData,
  resetSyncRuntimeStateForTests,
} from "./status";
import { FIXED_STRUCTURE_SHADOW_TABLES } from "./structure-shadow";
import type { LiveHandler, LiveSource, SyncDb, SyncQuery } from "./types";

function normalizeQuery(sql: SyncQuery, bindings?: Record<string, unknown>) {
  if (typeof sql === "string") return { sql, bindings };
  return { sql: sql.query, bindings: sql.bindings };
}

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];

  constructor(private readonly rowsByTable: Record<string, Array<Record<string, unknown>>> = {}) {}

  async query<T = unknown>(query: SyncQuery, bindings?: Record<string, unknown>): Promise<T> {
    const normalized = normalizeQuery(query, bindings);
    this.queries.push(normalized);

    if (normalized.sql.includes("SELECT * FROM type::table($table)")) {
      const table = String(normalized.bindings?.table ?? "");
      return [this.rowsByTable[table] ?? []] as T;
    }
    if (normalized.sql.includes("INFO FOR DB")) {
      return [{ tables: {} }] as T;
    }
    if (normalized.sql.includes("SELECT versionstamp")) {
      return [[]] as T;
    }
    return [[]] as T;
  }
}

class FakeLiveSource implements LiveSource {
  subscribed: string[] = [];
  async subscribe(table: string, _handler: LiveHandler): Promise<() => void> {
    this.subscribed.push(table);
    return () => {};
  }
}

describe("sync manager", () => {
  beforeEach(() => {
    resetSyncRuntimeStateForTests();
    stopSyncWorkers();
  });
  afterEach(async () => {
    await stopSyncWorkers();
  });

  test("在线启动时重建固定共享结构影子库", async () => {
    const local = new FakeDb();
    const remote = new FakeDb({
      app_user: [{ id: "app_user:u1", subject: "sub-1" }],
      workspace: [{ id: "workspace:ws1", owner: "app_user:u1", name: "默认工作区", slug: "default" }],
    });

    await startSyncWorkers({
      localDb: () => local,
      remoteDb: () => remote,
      isOnline: () => true,
    });

    expect(remote.queries.some((query) => query.sql.includes("SELECT * FROM type::table($table)"))).toBe(true);
    expect(remote.queries.every((query) => query.sql.includes("SELECT * FROM type::table($table)"))).toBe(true);
    expect(local.queries.some((query) => query.sql.includes("UPSERT $record CONTENT $content"))).toBe(true);
  });

  test("启动后会对所有固定共享表建立 LIVE 订阅", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();

    await startSyncWorkers({
      localDb: () => local,
      remoteDb: () => remote,
      liveSource: () => live,
      isOnline: () => true,
    });

    expect(live.subscribed).toEqual([...FIXED_STRUCTURE_SHADOW_TABLES]);
  });

  test("启动时刷新投影订阅成功后清除投影数据区 dirty", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();
    markDirtyProjectionData(true);

    await startSyncWorkers({
      localDb: () => local,
      remoteDb: () => remote,
      liveSource: () => live,
      isOnline: () => true,
    });

    expect(getSyncRuntimeState().dirtyProjectionData).toBe(false);
  });
});
