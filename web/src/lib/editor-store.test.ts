import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { GridColumnDef } from "@surreal-ck/shared/rpc.types";
import type { SurrealConn, LiveMessage } from "./surreal";
import { createEditorStore, type EditorSnapshot } from "./editor-store";

const columns: GridColumnDef[] = [
  { key: "name", label: "名称", fieldType: "text", required: true },
  { key: "amount", label: "金额", fieldType: "decimal" },
];

/** sheet 记录形态（column_defs 是 stored field def）。 */
function sheetRecord(over: Record<string, unknown> = {}) {
  return {
    id: "sheet:s1",
    workbook: "workbook:wb1",
    label: "工作表 1",
    table_name: "ent_claim",
    column_defs: [
      { key: "name", label: "名称", field_type: "text", required: true },
      { key: "amount", label: "金额", field_type: "decimal" },
    ],
    ...over,
  };
}

type Recorder = {
  queries: Array<{ sql: string; bindings: unknown }>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  creates: Array<{ table: string; data: Record<string, unknown> }>;
  deletes: string[];
  live: ((msg: LiveMessage) => void) | null;
};

/**
 * fake conn：第一条 `SELECT * FROM sheet ...` 返回 sheet 列表，其余 SELECT 返回行数据。
 * 用 `rows` 注入业务行；createRecord 给 draft 晋升一个真实 id。
 */
function setup(opts: { rows?: Array<Record<string, unknown>>; sheets?: Array<Record<string, unknown>> } = {}) {
  const rec: Recorder = { queries: [], updates: [], creates: [], deletes: [], live: null };
  const sheets = opts.sheets ?? [sheetRecord()];
  const rows = opts.rows ?? [];
  let createSeq = 0;

  const conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: (async (sql: string, bindings?: Record<string, unknown>) => {
      rec.queries.push({ sql, bindings });
      if (/FROM sheet/i.test(sql)) return sheets;
      return rows;
    }) as SurrealConn["query"],
    liveTable: (async (_table: string, onMessage: (m: LiveMessage) => void) => {
      rec.live = onMessage;
      return () => {};
    }) as SurrealConn["liveTable"],
    updateRecord: (async (id: string, patch: Record<string, unknown>) => {
      rec.updates.push({ id, patch });
      return { id, ...patch };
    }) as SurrealConn["updateRecord"],
    createRecord: (async (table: string, data: Record<string, unknown>) => {
      rec.creates.push({ table, data });
      createSeq += 1;
      return { id: `${table}:new${createSeq}`, ...data };
    }) as SurrealConn["createRecord"],
    deleteRecord: (async (id: string) => {
      rec.deletes.push(id);
      return {};
    }) as SurrealConn["deleteRecord"],
    transaction: (async (run: (tx: SurrealConn) => Promise<unknown>) => run(conn)) as SurrealConn["transaction"],
  } as SurrealConn;

  const snapshots: EditorSnapshot[] = [];
  const store = createEditorStore({
    getConn: () => conn,
    onChange: (snap) => snapshots.push(snap),
  });

  return { store, conn, rec, snapshots };
}

describe("loadWorkbook — 直连读 sheet 列表 + 首个 sheet 的行", () => {
  test("从 sheet 记录派生 columns + 业务行，并订阅 LIVE", async () => {
    const { store, rec } = setup({
      rows: [{ id: "ent_claim:a", name: "张三", amount: 100, created_at: "x" }],
    });

    await store.loadWorkbook("workbook:wb1");

    expect(rec.queries[0].sql).toMatch(/FROM sheet/);
    // workbook 是 record 字段：绑定须是 RecordId（StringRecordId），不能是裸 string，
    // 否则 `WHERE workbook = $wb` 与 record 比较永远不相等、查不到 sheet。
    const wb = (rec.queries[0].bindings as { wb: unknown }).wb;
    expect(wb).toBeInstanceOf(StringRecordId);
    expect(String(wb)).toBe("workbook:wb1");
    expect(store.activeSheetId).toBe("sheet:s1");
    expect(store.columns.map((c) => c.key)).toEqual(["name", "amount"]);
    expect(store.rows).toEqual([{ id: "ent_claim:a", values: { name: "张三", amount: 100 } }]);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(rec.live).not.toBeNull();
  });

  test("没有 sheet：error 提示且 rows 空", async () => {
    const { store } = setup({ sheets: [] });
    await store.loadWorkbook("workbook:empty");
    expect(store.error).not.toBeNull();
    expect(store.rows).toEqual([]);
  });

  test("sheet 列表派生进 store.sheets 并随快照发出（供 nav/topbar 消费）", async () => {
    const { store, snapshots } = setup({
      sheets: [
        sheetRecord({ id: "sheet:s1", label: "工作表 1" }),
        sheetRecord({ id: "sheet:s2", label: "工作表 2" }),
      ],
    });
    await store.loadWorkbook("workbook:wb1");

    expect(store.sheets.map((s) => s.id)).toEqual(["sheet:s1", "sheet:s2"]);
    expect(store.sheets.map((s) => s.label)).toEqual(["工作表 1", "工作表 2"]);
    const last = snapshots.at(-1)!;
    expect(last.sheets.map((s) => s.id)).toEqual(["sheet:s1", "sheet:s2"]);
  });
});

describe("saveRows — 持久化行直连 UPDATE/CREATE", () => {
  test("带 id 走 updateRecord，合并进 rows", async () => {
    const { store, rec } = setup({ rows: [{ id: "ent_claim:a", name: "张三", amount: 100 }] });
    await store.loadWorkbook("workbook:wb1");

    const ok = await store.saveRows([{ id: "ent_claim:a", values: { amount: 200 } }]);

    expect(ok).toBe(true);
    expect(rec.updates).toEqual([{ id: "ent_claim:a", patch: { name: "张三", amount: 200 } }]);
  });

  test("校验失败（必填 name 缺）→ saveError 且不写库", async () => {
    const { store, rec } = setup();
    await store.loadWorkbook("workbook:wb1");

    const ok = await store.saveRows([{ values: { amount: 5 } }]);

    expect(ok).toBe(false);
    expect(store.saveError).not.toBeNull();
    expect(rec.creates).toHaveLength(0);
  });
});

describe("deleteRows — 持久化删 DELETE，draft 本地丢弃", () => {
  test("持久化 id 走 deleteRecord 并从 rows 移除", async () => {
    const { store, rec } = setup({ rows: [{ id: "ent_claim:a", name: "甲" }, { id: "ent_claim:b", name: "乙" }] });
    await store.loadWorkbook("workbook:wb1");

    const ok = await store.deleteRows(["ent_claim:a"]);

    expect(ok).toBe(true);
    expect(rec.deletes).toEqual(["ent_claim:a"]);
    expect(store.rows.map((r) => r.id)).toEqual(["ent_claim:b"]);
  });

  test("draft id 不下发删除，仅本地移除", async () => {
    const { store, rec } = setup({ rows: [{ id: "ent_claim:a", name: "甲" }] });
    await store.loadWorkbook("workbook:wb1");
    store.insertBlankRows(null, 1, "end");
    const draftId = store.rows[store.rows.length - 1].id;

    const ok = await store.deleteRows([draftId]);

    expect(ok).toBe(true);
    expect(rec.deletes).toHaveLength(0);
    expect(store.rows.map((r) => r.id)).toEqual(["ent_claim:a"]);
  });
});

describe("draft 晋升 — saveFromSource 把填齐的 draft 写库换真实 id", () => {
  test("draft 必填填齐 → createRecord 晋升，draft id 换成真实 id", async () => {
    const { store, rec } = setup({ rows: [] });
    await store.loadWorkbook("workbook:wb1");
    store.insertBlankRows(null, 1, "end");
    const draftId = store.rows[0].id;

    await store.saveFromSource([{ _id: draftId, name: "新行", amount: 9 }]);

    expect(rec.creates).toHaveLength(1);
    expect(rec.creates[0].data).toMatchObject({ name: "新行", amount: 9 });
    expect(store.rows.map((r) => r.id)).toEqual(["ent_claim:new1"]);
    expect(store.pendingDraftCount).toBe(0);
  });

  test("draft 必填没填齐 → 不写库，留作 draft", async () => {
    const { store, rec } = setup({ rows: [] });
    await store.loadWorkbook("workbook:wb1");
    store.insertBlankRows(null, 1, "end");
    const draftId = store.rows[0].id;

    await store.saveFromSource([{ _id: draftId, amount: 9 }]);

    expect(rec.creates).toHaveLength(0);
    expect(store.pendingDraftCount).toBe(1);
  });
});

describe("viewParams 变更 → reloadRows 重新查询", () => {
  test("setFilters 把过滤编进 SELECT 并刷新 rows", async () => {
    const { store, rec } = setup({ rows: [{ id: "ent_claim:a", name: "张三" }] });
    await store.loadWorkbook("workbook:wb1");
    const before = rec.queries.length;

    await store.setFilters([{ key: "name", op: "eq", value: "张三" }]);

    const reload = rec.queries[rec.queries.length - 1];
    expect(rec.queries.length).toBeGreaterThan(before);
    expect(reload.sql).toContain("WHERE name = $f0");
    expect(reload.bindings).toMatchObject({ f0: "张三" });
    expect(store.viewParams.filters).toEqual([{ key: "name", op: "eq", value: "张三" }]);
  });

  test("setHiddenFields 只改视图参数，不重新查询；visibleColumns 反映隐藏", async () => {
    const { store, rec } = setup({ rows: [] });
    await store.loadWorkbook("workbook:wb1");
    const before = rec.queries.length;

    store.setHiddenFields(["amount"]);

    expect(rec.queries.length).toBe(before);
    expect(store.tableViewAdapter.visibleColumns.map((c) => c.key)).toEqual(["name"]);
  });
});

describe("LIVE 推送驱动 rows", () => {
  test("CREATE/UPDATE upsert，DELETE 移除", async () => {
    const { store, rec } = setup({ rows: [{ id: "ent_claim:a", name: "甲" }] });
    await store.loadWorkbook("workbook:wb1");

    rec.live?.({ action: "UPDATE", value: { id: "ent_claim:a", name: "甲改" } });
    expect(store.rows.find((r) => r.id === "ent_claim:a")?.values.name).toBe("甲改");

    rec.live?.({ action: "CREATE", value: { id: "ent_claim:c", name: "丙" } });
    expect(store.rows.map((r) => r.id)).toContain("ent_claim:c");

    rec.live?.({ action: "DELETE", value: { id: "ent_claim:a" } });
    expect(store.rows.map((r) => r.id)).not.toContain("ent_claim:a");
  });
});

describe("reset — 切 workspace 时清空并退订 LIVE", () => {
  test("reset 后状态归零，且 LIVE 已退订", async () => {
    let unsubbed = false;
    const { store } = setupWithUnsub(() => {
      unsubbed = true;
    });
    await store.loadWorkbook("workbook:wb1");
    store.insertBlankRows(null, 1, "end");

    store.reset();

    expect(store.activeSheetId).toBeNull();
    expect(store.rows).toEqual([]);
    expect(store.columns).toEqual([]);
    expect(store.pendingDraftCount).toBe(0);
    expect(unsubbed).toBe(true);
  });
});

function setupWithUnsub(onUnsub: () => void) {
  const sheets = [sheetRecord()];
  const conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: (async (sql: string) => (/FROM sheet/i.test(sql) ? sheets : [])) as SurrealConn["query"],
    liveTable: (async () => onUnsub) as SurrealConn["liveTable"],
    updateRecord: (async (_id: string, patch: Record<string, unknown>) => patch) as SurrealConn["updateRecord"],
    createRecord: (async (_t: string, data: Record<string, unknown>) => data) as SurrealConn["createRecord"],
    deleteRecord: (async () => ({})) as SurrealConn["deleteRecord"],
    transaction: (async (run: (tx: SurrealConn) => Promise<unknown>) => run(conn)) as SurrealConn["transaction"],
  } as SurrealConn;
  const store = createEditorStore({ getConn: () => conn });
  return { store, conn };
}
