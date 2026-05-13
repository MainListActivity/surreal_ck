import { describe, expect, test } from "bun:test";
import {
  FIXED_STRUCTURE_SHADOW_TABLES,
  rebuildFixedSharedStructureShadow,
} from "./structure-shadow";
import type { SyncDb, SyncQuery } from "./types";

function normalizeQuery(sql: SyncQuery, bindings?: Record<string, unknown>) {
  if (typeof sql === "string") return { sql, bindings };
  return { sql: sql.query, bindings: sql.bindings };
}

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];

  constructor(
    private readonly rowsByTable: Record<string, Array<Record<string, unknown>>> = {},
    private readonly failSelectTables = new Set<string>(),
  ) {}

  async query<T = unknown>(query: SyncQuery, bindings?: Record<string, unknown>): Promise<T> {
    const normalized = normalizeQuery(query, bindings);
    this.queries.push(normalized);

    if (normalized.sql.includes("SELECT * FROM type::table($table)")) {
      const table = String(normalized.bindings?.table ?? "");
      if (this.failSelectTables.has(table)) throw new Error("remote unavailable");
      return [this.rowsByTable[table] ?? []] as T;
    }
    if (normalized.sql.includes("DELETE FROM type::table($table)")) {
      const table = String(normalized.bindings?.table ?? "");
      this.rowsByTable[table] = [];
      return [[]] as T;
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

    return [[]] as T;
  }

  rows(table: string): Array<Record<string, unknown>> {
    return [...(this.rowsByTable[table] ?? [])];
  }
}

describe("固定共享结构影子库重建", () => {
  test("从 remote 按固定结构顺序拉取并写入 local", async () => {
    const remote = new FakeDb({
      app_user: [{ id: "app_user:u1", subject: "sub-1" }],
      workspace: [{ id: "workspace:ws1", owner: "app_user:u1", name: "默认工作区", slug: "default" }],
      workbook: [{ id: "workbook:wb1", workspace: "workspace:ws1", name: "台账" }],
    });
    const local = new FakeDb();

    const result = await rebuildFixedSharedStructureShadow({ localDb: local, remoteDb: remote });

    const remoteTables = remote.queries.map((query) => query.bindings?.table);
    expect(remoteTables).toEqual([...FIXED_STRUCTURE_SHADOW_TABLES]);

    const upserts = local.queries.filter((query) => query.sql.includes("UPSERT $record CONTENT $content"));
    expect(upserts).toHaveLength(3);
    expect(upserts.map((query) => String(query.bindings?.record))).toEqual([
      "app_user:u1",
      "workspace:ws1",
      "workbook:wb1",
    ]);
    expect(upserts[0]?.bindings?.content).toMatchObject({
      subject: "sub-1",
      _origin_session_id: "remote:structure-rebuild",
    });
    expect(result).toEqual({
      tables: [
        { table: "app_user", rows: 1 },
        { table: "workspace", rows: 1 },
        { table: "has_workspace_member", rows: 0 },
        { table: "pending_workspace_member", rows: 0 },
        { table: "folder", rows: 0 },
        { table: "workbook", rows: 1 },
        { table: "sheet", rows: 0 },
        { table: "edge_catalog", rows: 0 },
      ],
      totalRows: 3,
    });
  });

  test("清空本地结构影子库后再次重建恢复同一状态", async () => {
    const remote = new FakeDb({
      app_user: [{ id: "app_user:u1", subject: "sub-1" }],
      workspace: [{ id: "workspace:ws1", owner: "app_user:u1", name: "默认工作区", slug: "default" }],
    });
    const local = new FakeDb({
      app_user: [{ id: "app_user:stale", subject: "stale" }],
      workspace: [{ id: "workspace:stale", name: "过期工作区", slug: "stale" }],
    });

    await rebuildFixedSharedStructureShadow({ localDb: local, remoteDb: remote });
    const firstWorkspaceRows = local.rows("workspace");

    await rebuildFixedSharedStructureShadow({ localDb: local, remoteDb: remote });

    expect(local.rows("app_user")).toEqual([
      { id: "app_user:u1", subject: "sub-1", _origin_session_id: "remote:structure-rebuild" },
    ]);
    expect(local.rows("workspace")).toEqual(firstWorkspaceRows);
    expect(local.rows("workspace")).toEqual([
      {
        id: "workspace:ws1",
        owner: "app_user:u1",
        name: "默认工作区",
        slug: "default",
        _origin_session_id: "remote:structure-rebuild",
      },
    ]);
  });

  test("远端不可达时失败信息包含重建阶段且不会清空本地影子", async () => {
    const remote = new FakeDb(
      { app_user: [{ id: "app_user:u1", subject: "sub-1" }] },
      new Set(["workspace"]),
    );
    const local = new FakeDb({
      workspace: [{ id: "workspace:cached", name: "本地缓存", slug: "cached" }],
    });

    await expect(rebuildFixedSharedStructureShadow({ localDb: local, remoteDb: remote }))
      .rejects.toThrow(
        `fixed structure shadow rebuild remote fetch table=workspace query="SELECT * FROM type::table($table)" bindings.table=workspace: remote unavailable`,
      );

    expect(local.queries).toHaveLength(0);
    expect(local.rows("workspace")).toEqual([
      { id: "workspace:cached", name: "本地缓存", slug: "cached" },
    ]);
  });
});
