import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  recoverDirtyStructureShadow,
  startFixedSharedLiveSubscriptions,
  stopFixedSharedLiveSubscriptions,
} from "./structure-live";
import {
  getSyncRuntimeState,
  markDirtyStructureShadow,
  resetSyncRuntimeStateForTests,
} from "./status";

function markDirtyForTest() {
  markDirtyStructureShadow(true);
}
import type { LiveMessage, LiveSource, SyncDb, SyncQuery } from "./types";

function normalizeQuery(sql: SyncQuery, bindings?: Record<string, unknown>) {
  if (typeof sql === "string") return { sql, bindings };
  return { sql: sql.query, bindings: sql.bindings };
}

type Handler = (message: LiveMessage) => void | Promise<void>;

class FakeLiveSource implements LiveSource {
  handlers = new Map<string, Set<Handler>>();
  unsubscribed = new Map<string, number>();
  subscribeCalls: string[] = [];
  failTables = new Set<string>();

  async subscribe(table: string, handler: Handler): Promise<() => void> {
    this.subscribeCalls.push(table);
    if (this.failTables.has(table)) {
      throw new Error(`subscribe failed for ${table}`);
    }
    const set = this.handlers.get(table) ?? new Set();
    set.add(handler);
    this.handlers.set(table, set);
    return () => {
      set.delete(handler);
      this.unsubscribed.set(table, (this.unsubscribed.get(table) ?? 0) + 1);
    };
  }

  async emit(table: string, message: LiveMessage): Promise<void> {
    const set = this.handlers.get(table);
    if (!set) return;
    for (const handler of set) await handler(message);
  }
}

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  rowsByTable: Record<string, Array<Record<string, unknown>>> = {};
  failApply = false;

  async query<T = unknown>(sql: SyncQuery, bindings?: Record<string, unknown>): Promise<T> {
    const normalized = normalizeQuery(sql, bindings);
    this.queries.push(normalized);

    if (this.failApply && normalized.sql.includes("UPSERT $record CONTENT $content")) {
      throw new Error("local apply failed");
    }
    if (this.failApply && normalized.sql.includes("DELETE $record")) {
      throw new Error("local apply failed");
    }

    if (normalized.sql.includes("UPSERT $record CONTENT $content")) {
      const recordId = String(normalized.bindings?.record);
      const table = recordId.split(":")[0] ?? "";
      const content = normalized.bindings?.content as Record<string, unknown>;
      const next = { id: recordId, ...content };
      const rows = this.rowsByTable[table] ?? [];
      const index = rows.findIndex((row) => String(row.id) === recordId);
      if (index === -1) rows.push(next);
      else rows[index] = next;
      this.rowsByTable[table] = rows;
      return [[next]] as T;
    }
    if (normalized.sql.includes("DELETE $record")) {
      const recordId = String(normalized.bindings?.record);
      const table = recordId.split(":")[0] ?? "";
      this.rowsByTable[table] = (this.rowsByTable[table] ?? []).filter(
        (row) => String(row.id) !== recordId,
      );
      return [[]] as T;
    }
    return [[]] as T;
  }

  rows(table: string): Array<Record<string, unknown>> {
    return [...(this.rowsByTable[table] ?? [])];
  }
}

describe("固定共享表 LIVE 增量与 dirty 重建", () => {
  beforeEach(() => {
    resetSyncRuntimeStateForTests();
  });
  afterEach(async () => {
    await stopFixedSharedLiveSubscriptions();
  });

  test("CREATE 事件会被回放为本地影子 upsert", async () => {
    const local = new FakeDb();
    const live = new FakeLiveSource();

    await startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live });

    await live.emit("workspace", {
      action: "CREATE",
      recordId: "workspace:new1",
      value: { id: "workspace:new1", name: "新工作区", slug: "n1" },
    });

    expect(local.rows("workspace")).toEqual([
      {
        id: "workspace:new1",
        name: "新工作区",
        slug: "n1",
        _origin_session_id: "remote:live",
      },
    ]);
  });

  test("UPDATE 事件覆盖既有影子内容", async () => {
    const local = new FakeDb();
    local.rowsByTable.workspace = [
      { id: "workspace:ws1", name: "旧名", slug: "old" },
    ];
    const live = new FakeLiveSource();
    await startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live });

    await live.emit("workspace", {
      action: "UPDATE",
      recordId: "workspace:ws1",
      value: { id: "workspace:ws1", name: "新名", slug: "new" },
    });

    expect(local.rows("workspace")).toEqual([
      {
        id: "workspace:ws1",
        name: "新名",
        slug: "new",
        _origin_session_id: "remote:live",
      },
    ]);
  });

  test("DELETE 事件移除本地影子行", async () => {
    const local = new FakeDb();
    local.rowsByTable.workspace = [
      { id: "workspace:gone", name: "待删", slug: "g" },
    ];
    const live = new FakeLiveSource();
    await startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live });

    await live.emit("workspace", {
      action: "DELETE",
      recordId: "workspace:gone",
      value: { id: "workspace:gone" },
    });

    expect(local.rows("workspace")).toEqual([]);
  });

  test("apply 失败时把结构影子标记为 dirty", async () => {
    const local = new FakeDb();
    local.failApply = true;
    const live = new FakeLiveSource();
    await startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live });

    await live.emit("workspace", {
      action: "CREATE",
      recordId: "workspace:bad",
      value: { id: "workspace:bad", name: "失败", slug: "b" },
    });

    expect(getSyncRuntimeState().dirtyStructureShadow).toBe(true);
  });

  test("KILLED 事件把结构影子标记为 dirty", async () => {
    const local = new FakeDb();
    const live = new FakeLiveSource();
    await startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live });

    await live.emit("workspace", {
      action: "KILLED",
      recordId: "workspace:any",
      value: {},
    });

    expect(getSyncRuntimeState().dirtyStructureShadow).toBe(true);
  });

  test("subscribe 失败时把结构影子标记为 dirty 并清掉已注册订阅", async () => {
    const local = new FakeDb();
    const live = new FakeLiveSource();
    live.failTables.add("sheet");

    await expect(
      startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live }),
    ).rejects.toThrow();

    expect(getSyncRuntimeState().dirtyStructureShadow).toBe(true);
    // 已经成功注册的订阅应当被回滚
    for (const table of live.handlers.keys()) {
      expect(live.handlers.get(table)?.size ?? 0).toBe(0);
    }
  });

  test("dirty 时 recoverDirtyStructureShadow 会重建并清除 dirty", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    remote.rowsByTable = {
      app_user: [{ id: "app_user:u1", subject: "sub-1" }],
      workspace: [{ id: "workspace:ws1", name: "ws", slug: "w" }],
    };
    // 让 remote 也实现 SELECT * FROM type::table($table)
    const origQuery = remote.query.bind(remote);
    remote.query = async <T>(sql: any, bindings?: any): Promise<T> => {
      const text = typeof sql === "string" ? sql : sql.query;
      if (text.includes("SELECT * FROM type::table($table)")) {
        const table = String(bindings?.table ?? "");
        return [remote.rowsByTable[table] ?? []] as T;
      }
      return origQuery<T>(sql, bindings);
    };

    markDirtyForTest();

    await recoverDirtyStructureShadow({ localDb: local, remoteDb: remote });

    expect(local.rows("workspace")).toEqual([
      {
        id: "workspace:ws1",
        name: "ws",
        slug: "w",
        _origin_session_id: "remote:structure-rebuild",
      },
    ]);
    expect(getSyncRuntimeState().dirtyStructureShadow).toBe(false);
  });

  test("不 dirty 时 recoverDirtyStructureShadow 不触发重建", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();

    await recoverDirtyStructureShadow({ localDb: local, remoteDb: remote });

    expect(remote.queries).toHaveLength(0);
  });

  test("stop 后再次 emit 不再写本地", async () => {
    const local = new FakeDb();
    const live = new FakeLiveSource();
    await startFixedSharedLiveSubscriptions({ localDb: local, liveSource: live });
    await stopFixedSharedLiveSubscriptions();

    await live.emit("workspace", {
      action: "CREATE",
      recordId: "workspace:after-stop",
      value: { id: "workspace:after-stop", name: "x", slug: "x" },
    });

    expect(local.rows("workspace")).toEqual([]);
  });
});
