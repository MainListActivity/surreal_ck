import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SyncDb, SyncQuery } from "../sync/types";

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
    if (text.includes("SELECT rel_table, workspace FROM edge_catalog")) {
      return [this.rowsByTable.edge_catalog ?? []] as T;
    }
    if (text.includes("SELECT * FROM type::table($table)")) {
      const table = String(normalized.bindings?.table ?? "");
      return [this.rowsByTable[table] ?? []] as T;
    }
    if (text.includes("DELETE FROM type::table($table) WHERE workspace = $workspace")) {
      const table = String(normalized.bindings?.table ?? "");
      const workspace = String(normalized.bindings?.workspace ?? "");
      this.rowsByTable[table] = (this.rowsByTable[table] ?? []).filter(
        (row) => String(row.workspace) !== workspace,
      );
      return [[]] as T;
    }
    if (text.includes("DELETE FROM type::table($table)")) {
      const table = String(normalized.bindings?.table ?? "");
      this.rowsByTable[table] = [];
      return [[]] as T;
    }
    if (text.includes("UPSERT $record CONTENT $content")) {
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
    return [[]] as T;
  }

  rows(table: string): Array<Record<string, unknown>> {
    return [...(this.rowsByTable[table] ?? [])];
  }
}

let local = new FakeDb();
let remote: FakeDb | null = new FakeDb();
let handledRemoteQueryFailures: unknown[] = [];

mock.module("../db/index", () => ({
  getLocalDb: () => local,
  getRemoteDb: () => remote,
  handleRemoteQueryFailure: async (_remote: SyncDb, err: unknown) => {
    handledRemoteQueryFailures.push(err);
    remote = null;
    return true;
  },
}));

import {
  getSyncRuntimeState,
  markDirtyProjectionData,
  markDirtyStructureShadow,
  resetSyncRuntimeStateForTests,
} from "../sync/status";
import { triggerSyncRebuild } from "./sync-state-v2";

describe("triggerSyncRebuild", () => {
  beforeEach(() => {
    local = new FakeDb();
    remote = new FakeDb();
    handledRemoteQueryFailures = [];
    resetSyncRuntimeStateForTests();
  });

  test("重建结构影子后重建 ent/rel 投影并清除 dirty", async () => {
    remote!.rowsByTable.sheet = [
      { id: "sheet:s1", table_name: "ent_ws1_a", column_defs: [] },
    ];
    remote!.rowsByTable.edge_catalog = [
      { id: "edge_catalog:e1", rel_table: "rel_ws1_a", workspace: "workspace:ws1" },
    ];
    remote!.rowsByTable.ent_ws1_a = [
      { id: "ent_ws1_a:r1", name: "fresh" },
    ];
    remote!.rowsByTable.rel_ws1_a = [
      { id: "rel_ws1_a:r1", in: "ent_ws1_a:r1", out: "ent_ws1_a:r2", workspace: "workspace:ws1" },
    ];
    local.rowsByTable.ent_ws1_a = [{ id: "ent_ws1_a:stale", name: "stale" }];
    local.rowsByTable.rel_ws1_a = [{ id: "rel_ws1_a:stale", workspace: "workspace:ws1" }];
    markDirtyStructureShadow(true);
    markDirtyProjectionData(true);

    const status = await triggerSyncRebuild();

    expect(status.dirtyStructureShadow).toBe(false);
    expect(status.dirtyProjectionData).toBe(false);
    expect(getSyncRuntimeState().dirtyProjectionData).toBe(false);
    expect(local.rows("ent_ws1_a")).toEqual([
      { id: "ent_ws1_a:r1", name: "fresh", _origin_session_id: "remote:projection-rebuild" },
    ]);
    expect(local.rows("rel_ws1_a")).toEqual([
      {
        id: "rel_ws1_a:r1",
        in: "ent_ws1_a:r1",
        out: "ent_ws1_a:r2",
        workspace: "workspace:ws1",
        _origin_session_id: "remote:projection-rebuild",
      },
    ]);
  });

  test("远端连接断开时返回离线状态而不是抛出原始 SurrealDB SQL 错误", async () => {
    const disconnected = new Error(
      `fixed structure shadow rebuild remote fetch table=app_user query="SELECT * FROM type::table($table)" bindings.table=app_user: You must be connected to a SurrealDB instance before performing this operation`,
    );
    remote!.query = async <T = unknown>(): Promise<T> => {
      throw disconnected;
    };

    const status = await triggerSyncRebuild();

    expect(status.online).toBe(false);
    expect(status.rebuildInProgress).toBe(false);
    expect(handledRemoteQueryFailures).toHaveLength(1);
    expect(String((handledRemoteQueryFailures[0] as Error).message)).toContain(
      "You must be connected to a SurrealDB instance before performing this operation",
    );
  });
});
