import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  rebuildEntProjections,
  refreshEntProjectionSubscriptions,
  stopEntProjectionSubscriptions,
} from "./ent-projection";
import { getSyncRuntimeState, resetSyncRuntimeStateForTests } from "./status";
import type { LiveHandler, LiveMessage, LiveSource, SyncDb, SyncQuery } from "./types";

function normalizeQuery(sql: SyncQuery, bindings?: Record<string, unknown>) {
  if (typeof sql === "string") return { sql, bindings };
  return { sql: sql.query, bindings: sql.bindings };
}

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  rowsByTable: Record<string, Array<Record<string, unknown>>> = {};

  async query<T = unknown>(sql: SyncQuery, bindings?: Record<string, unknown>): Promise<T> {
    const normalized = normalizeQuery(sql, bindings);
    this.queries.push(normalized);
    const text = normalized.sql;

    if (text.includes("SELECT table_name, column_defs FROM sheet")) {
      return [this.rowsByTable.sheet ?? []] as T;
    }
    if (text.includes("SELECT * FROM type::table($table)")) {
      const table = String(bindings?.table ?? "");
      return [this.rowsByTable[table] ?? []] as T;
    }
    if (text.includes("DELETE FROM type::table($table)")) {
      const table = String(bindings?.table ?? "");
      this.rowsByTable[table] = [];
      return [[]] as T;
    }
    if (text.includes("UPSERT $record CONTENT $content")) {
      const recordId = String(bindings?.record);
      const table = recordId.split(":")[0] ?? "";
      const content = bindings?.content as Record<string, unknown>;
      const next = { id: recordId, ...content };
      const rows = this.rowsByTable[table] ?? [];
      const index = rows.findIndex((row) => String(row.id) === recordId);
      if (index === -1) rows.push(next);
      else rows[index] = next;
      this.rowsByTable[table] = rows;
      return [[next]] as T;
    }
    if (text.startsWith("DEFINE TABLE")) {
      return [[]] as T;
    }
    return [[]] as T;
  }

  rows(table: string): Array<Record<string, unknown>> {
    return [...(this.rowsByTable[table] ?? [])];
  }
}

class FakeLiveSource implements LiveSource {
  handlers = new Map<string, Set<LiveHandler>>();
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];

  async subscribe(table: string, handler: LiveHandler): Promise<() => void> {
    this.subscribeCalls.push(table);
    const set = this.handlers.get(table) ?? new Set();
    set.add(handler);
    this.handlers.set(table, set);
    return () => {
      set.delete(handler);
      this.unsubscribeCalls.push(table);
    };
  }

  async emit(table: string, message: LiveMessage): Promise<void> {
    const handlers = this.handlers.get(table);
    if (!handlers) return;
    for (const h of handlers) await h(message);
  }
}

describe("ent_* metadata-driven 投影", () => {
  beforeEach(() => {
    resetSyncRuntimeStateForTests();
  });
  afterEach(async () => {
    await stopEntProjectionSubscriptions();
  });

  test("按 local sheet 元数据驱动远端全量拉取并写入本地 ent_*", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    local.rowsByTable.sheet = [
      { table_name: "ent_ws1_a", column_defs: [{ key: "name", label: "名", field_type: "text" }] },
    ];
    remote.rowsByTable.ent_ws1_a = [
      { id: "ent_ws1_a:r1", name: "alice" },
      { id: "ent_ws1_a:r2", name: "bob" },
    ];

    await rebuildEntProjections({ localDb: local, remoteDb: remote });

    expect(local.rows("ent_ws1_a")).toEqual([
      {
        id: "ent_ws1_a:r1",
        name: "alice",
        _origin_session_id: "remote:projection-rebuild",
      },
      {
        id: "ent_ws1_a:r2",
        name: "bob",
        _origin_session_id: "remote:projection-rebuild",
      },
    ]);
  });

  test("重建时会清空旧 ent_* 数据后再写入", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    local.rowsByTable.sheet = [
      { table_name: "ent_ws1_a", column_defs: [] },
    ];
    local.rowsByTable.ent_ws1_a = [
      { id: "ent_ws1_a:stale", name: "stale" },
    ];
    remote.rowsByTable.ent_ws1_a = [
      { id: "ent_ws1_a:r1", name: "fresh" },
    ];

    await rebuildEntProjections({ localDb: local, remoteDb: remote });

    expect(local.rows("ent_ws1_a").map((r) => r.id)).toEqual(["ent_ws1_a:r1"]);
  });
  test("订阅集差量：新增 sheet 触发单表全量+LIVE，移除 sheet 停 LIVE 并清本地投影", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();

    // 初始有 sheet A
    local.rowsByTable.sheet = [
      { table_name: "ent_ws1_a", column_defs: [] },
    ];
    remote.rowsByTable.ent_ws1_a = [{ id: "ent_ws1_a:r1", v: 1 }];

    await refreshEntProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });

    expect(live.subscribeCalls).toEqual(["ent_ws1_a"]);
    expect(local.rows("ent_ws1_a").map((r) => r.id)).toEqual(["ent_ws1_a:r1"]);

    // 替换 sheet 集：A 被移除，新增 B
    local.rowsByTable.sheet = [
      { table_name: "ent_ws1_b", column_defs: [] },
    ];
    local.rowsByTable.ent_ws1_a = [{ id: "ent_ws1_a:r1", v: 1 }]; // 上次写入
    remote.rowsByTable.ent_ws1_b = [{ id: "ent_ws1_b:r2", v: 2 }];

    await refreshEntProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });

    expect(live.subscribeCalls).toEqual(["ent_ws1_a", "ent_ws1_b"]);
    expect(live.unsubscribeCalls).toEqual(["ent_ws1_a"]);
    expect(local.rows("ent_ws1_a")).toEqual([]); // 已清
    expect(local.rows("ent_ws1_b").map((r) => r.id)).toEqual(["ent_ws1_b:r2"]);
  });
  test("未变化 sheet 保留现有订阅不重建", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();

    local.rowsByTable.sheet = [{ table_name: "ent_ws1_a", column_defs: [] }];
    remote.rowsByTable.ent_ws1_a = [{ id: "ent_ws1_a:r1", v: 1 }];

    await refreshEntProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });
    const firstSubscribe = [...live.subscribeCalls];
    const localQueryCountAfterFirst = local.queries.length;

    // 再次刷新，sheet 未变化
    await refreshEntProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });

    expect(live.subscribeCalls).toEqual(firstSubscribe);
    expect(live.unsubscribeCalls).toEqual([]);
    // 第二次刷新只会查 sheet 列表，不应再触发 DELETE/UPSERT
    const secondPhase = local.queries.slice(localQueryCountAfterFirst);
    const wroteEnt = secondPhase.some((q) => q.sql.includes("DELETE FROM type::table($table)") || q.sql.includes("UPSERT $record"));
    expect(wroteEnt).toBe(false);
  });

  test("ent_* LIVE 断开时标记投影数据区 dirty，而不是结构影子库 dirty", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();
    local.rowsByTable.sheet = [{ table_name: "ent_ws1_a", column_defs: [] }];

    await refreshEntProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });
    await live.emit("ent_ws1_a", {
      action: "KILLED",
      recordId: "ent_ws1_a:any",
      value: {},
    });

    expect(getSyncRuntimeState()).toMatchObject({
      dirtyProjectionData: true,
      dirtyStructureShadow: false,
    });
  });
});
