import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  rebuildRelProjections,
  refreshRelProjectionSubscriptions,
  stopRelProjectionSubscriptions,
} from "./rel-projection";
import { resetSyncRuntimeStateForTests } from "./status";
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

    if (text.includes("SELECT rel_table, workspace FROM edge_catalog")) {
      return [this.rowsByTable.edge_catalog ?? []] as T;
    }
    if (text.includes("SELECT * FROM type::table($table)")) {
      const table = String(bindings?.table ?? "");
      return [this.rowsByTable[table] ?? []] as T;
    }
    if (text.includes("DELETE FROM type::table($table) WHERE workspace = $workspace")) {
      const table = String(bindings?.table ?? "");
      const workspace = String(bindings?.workspace ?? "");
      this.rowsByTable[table] = (this.rowsByTable[table] ?? []).filter(
        (row) => String(row.workspace) !== workspace,
      );
      return [[]] as T;
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
    const set = this.handlers.get(table);
    if (!set) return;
    for (const h of set) await h(message);
  }
}

describe("rel_* metadata-driven 投影", () => {
  beforeEach(() => resetSyncRuntimeStateForTests());
  afterEach(async () => {
    await stopRelProjectionSubscriptions();
  });

  test("按 edge_catalog 拉取并写入本地 rel_*，携带 workspace 归属键", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();

    local.rowsByTable.edge_catalog = [
      { rel_table: "rel_ws1_a", workspace: "workspace:ws1" },
    ];
    remote.rowsByTable.rel_ws1_a = [
      { id: "rel_ws1_a:r1", in: "ent_ws1_x:1", out: "ent_ws1_y:1", workspace: "workspace:ws1" },
    ];

    await refreshRelProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });

    expect(live.subscribeCalls).toEqual(["rel_ws1_a"]);
    expect(local.rows("rel_ws1_a").map((r) => r.id)).toEqual(["rel_ws1_a:r1"]);
    expect(local.rows("rel_ws1_a")[0]?.workspace).toBe("workspace:ws1");
  });

  test("按 edge_catalog 全量重建 rel_* 投影", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    local.rowsByTable.edge_catalog = [
      { rel_table: "rel_ws1_a", workspace: "workspace:ws1" },
    ];
    local.rowsByTable.rel_ws1_a = [
      { id: "rel_ws1_a:stale", workspace: "workspace:ws1" },
      { id: "rel_ws1_a:other", workspace: "workspace:other" },
    ];
    remote.rowsByTable.rel_ws1_a = [
      { id: "rel_ws1_a:r1", in: "ent_x:1", out: "ent_y:1", workspace: "workspace:ws1" },
    ];

    await rebuildRelProjections({ localDb: local, remoteDb: remote });

    expect(local.rows("rel_ws1_a")).toEqual([
      { id: "rel_ws1_a:other", workspace: "workspace:other" },
      {
        id: "rel_ws1_a:r1",
        in: "ent_x:1",
        out: "ent_y:1",
        workspace: "workspace:ws1",
        _origin_session_id: "remote:projection-rebuild",
      },
    ]);
  });

  test("移除 edge_catalog 行时停止 LIVE 并按 workspace 清本地 rel_*", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();

    local.rowsByTable.edge_catalog = [
      { rel_table: "rel_ws1_a", workspace: "workspace:ws1" },
    ];
    remote.rowsByTable.rel_ws1_a = [
      { id: "rel_ws1_a:r1", in: "ent_x:1", out: "ent_y:1", workspace: "workspace:ws1" },
    ];

    await refreshRelProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });
    expect(local.rows("rel_ws1_a")).toHaveLength(1);

    // 移除 edge_catalog
    local.rowsByTable.edge_catalog = [];
    await refreshRelProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });

    expect(live.unsubscribeCalls).toEqual(["rel_ws1_a"]);
    expect(local.rows("rel_ws1_a")).toEqual([]);
  });

  test("未变化 rel_* 表保留订阅不重新拉取", async () => {
    const local = new FakeDb();
    const remote = new FakeDb();
    const live = new FakeLiveSource();

    local.rowsByTable.edge_catalog = [
      { rel_table: "rel_ws1_a", workspace: "workspace:ws1" },
    ];
    remote.rowsByTable.rel_ws1_a = [];

    await refreshRelProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });
    const localCountAfterFirst = local.queries.length;

    await refreshRelProjectionSubscriptions({ localDb: local, remoteDb: remote, liveSource: live });

    expect(live.subscribeCalls).toEqual(["rel_ws1_a"]);
    expect(live.unsubscribeCalls).toEqual([]);
    const secondPhase = local.queries.slice(localCountAfterFirst);
    const reWrote = secondPhase.some(
      (q) => q.sql.includes("DELETE FROM type::table($table)") || q.sql.includes("UPSERT $record"),
    );
    expect(reWrote).toBe(false);
  });
});
