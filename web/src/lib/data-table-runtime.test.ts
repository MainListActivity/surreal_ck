import { describe, expect, test } from "bun:test";
import type { GridColumnDef, ViewParams } from "@surreal-ck/shared/rpc.types";
import type { LiveMessage, SurrealConn, SurrealTransactionWriter } from "./surreal";
import { openDataTableRuntime } from "./data-table-runtime";
import type { TemplateImportMapping } from "./template-sheet-import";

const columns: GridColumnDef[] = [
  { key: "name", label: "名称", fieldType: "text", required: true },
  { key: "amount", label: "金额", fieldType: "decimal" },
];

const emptyView: ViewParams = {
  filters: [],
  filterMode: "and",
  sorts: [],
  hiddenFields: [],
  groupBy: null,
};

function storedColumns() {
  return [
    { key: "name", label: "名称", field_type: "text", required: true },
    { key: "amount", label: "金额", field_type: "decimal" },
  ];
}

function runtimeHarness(
  initialRows: Array<Record<string, unknown>> = [],
  runtimeColumns = storedColumns(),
) {
  let rows = initialRows.map((row) => ({ ...row }));
  let live: ((message: LiveMessage) => void) | null = null;
  let unsubscribed = false;
  let createSeq = 0;
  const calls: string[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const creates: Array<{ table: string; data: Record<string, unknown> }> = [];
  const txCalls: string[] = [];

  const writer = {
    async updateRecord(id: string, patch: Record<string, unknown>) {
      updates.push({ id, patch });
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return { id, ...patch };
      rows[index] = { ...rows[index], ...patch };
      return { ...rows[index] };
    },
    async createRecord(table: string, data: Record<string, unknown>) {
      creates.push({ table, data });
      createSeq += 1;
      const created = { id: `${table}:new${createSeq}`, ...data };
      rows.push(created);
      return created;
    },
    async deleteRecord(id: string) {
      rows = rows.filter((row) => row.id !== id);
      return {};
    },
  };

  const conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: (async (sql: string) => {
      calls.push(sql);
      if (/FROM sheet/i.test(sql)) {
        return [{
          id: "sheet:s1",
          workbook: "workbook:w1",
          label: "数据表 1",
          table_name: "ent_claim",
          column_defs: runtimeColumns,
        }];
      }
      return rows.map((row) => ({ ...row }));
    }) as SurrealConn["query"],
    liveTable: (async (_table: string, handler: (message: LiveMessage) => void) => {
      calls.push("LIVE");
      live = handler;
      return () => { unsubscribed = true; };
    }) as SurrealConn["liveTable"],
    ...writer,
    transaction: (async (run: (tx: SurrealTransactionWriter) => Promise<unknown>) => {
      txCalls.push("BEGIN");
      const tx: SurrealTransactionWriter = {
        ...writer,
        query: (async (sql: string) => {
          txCalls.push(sql);
          return /SELECT \*/i.test(sql) ? rows.map((row) => ({ ...row })) : [];
        }) as SurrealTransactionWriter["query"],
      };
      const result = await run(tx);
      txCalls.push("COMMIT");
      return result;
    }) as SurrealConn["transaction"],
  } as SurrealConn;

  return {
    conn,
    calls,
    updates,
    creates,
    txCalls,
    get live() { return live; },
    get unsubscribed() { return unsubscribed; },
    setRows(next: Array<Record<string, unknown>>) { rows = next.map((row) => ({ ...row })); },
  };
}

describe("数据表运行时打开与记录入口", () => {
  test("先建立 LIVE 再查询正式记录，并验证工作簿 + 数据表归属", async () => {
    const h = runtimeHarness([{ id: "ent_claim:a", name: "甲", amount: 1 }]);
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    const metadataIndex = h.calls.findIndex((sql) => /FROM sheet/i.test(sql));
    const liveIndex = h.calls.indexOf("LIVE");
    const recordsIndex = h.calls.findIndex((sql) => /type::table/i.test(sql));
    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(liveIndex).toBeGreaterThan(metadataIndex);
    expect(recordsIndex).toBeGreaterThan(liveIndex);
    expect(runtime.snapshot.records).toEqual([{ id: "ent_claim:a", values: { name: "甲", amount: 1 } }]);
  });

  test("完整记录用于校验，数据库 MERGE 只携带实际变化字段", async () => {
    const h = runtimeHarness([{ id: "ent_claim:a", name: "甲", amount: 1 }]);
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    const result = await runtime.updateRecords([{ id: "ent_claim:a", values: { amount: 2 } }]);
    expect(result.ok).toBe(true);
    expect(h.updates).toEqual([{ id: "ent_claim:a", patch: { amount: 2 } }]);
    expect(runtime.snapshot.records[0].values).toEqual({ name: "甲", amount: 2 });
  });

  test("patch 按 schema coerce，清空值保留到 SDK 边界，未知字段被拒绝", async () => {
    const h = runtimeHarness([{ id: "ent_claim:a", name: "甲", amount: 1 }]);
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    expect((await runtime.updateRecords([{
      id: "ent_claim:a",
      values: { amount: "2" },
    }])).ok).toBe(true);
    expect(h.updates.at(-1)?.patch.amount).toBe(2);

    expect((await runtime.updateRecords([{
      id: "ent_claim:a",
      values: { amount: "" },
    }])).ok).toBe(true);
    expect(h.updates.at(-1)?.patch).toHaveProperty("amount");
    expect(h.updates.at(-1)?.patch.amount).toBeUndefined();

    const unknown = await runtime.updateRecords([{
      id: "ent_claim:a",
      values: { injected: true },
    }]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("validation");
  });

  test("记录草稿由运行时判断 incomplete / promoted", async () => {
    const h = runtimeHarness();
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    expect((await runtime.promoteDraft({ amount: 1 })).status).toBe("incomplete");
    const promoted = await runtime.promoteDraft({ name: "乙", amount: 2 });
    expect(promoted.status).toBe("promoted");
    if (promoted.status === "promoted") expect(promoted.record.id).toBe("ent_claim:new1");
  });

  test("CSV 导入按显示值解析引用，未命中行不写入且可只重试修正后的原始行", async () => {
    const h = runtimeHarness([], [
      { key: "material_name", label: "材料名称", field_type: "text", required: true },
      {
        key: "creditor",
        label: "关联债权人",
        field_type: "reference",
        required: true,
        reference_table: "ent_creditor",
        reference_display_key: "creditor_name",
      },
    ]);
    const baseQuery = h.conn.query.bind(h.conn);
    const referenceQueries: string[] = [];
    h.conn.query = (async (sql: string, bindings?: Record<string, unknown>) => {
      if (/FROM ent_creditor/i.test(sql)) {
        referenceQueries.push(sql);
        return [
          { id: "ent_creditor:c1", creditor_name: "远航供应链有限公司" },
          { id: "ent_creditor:c2", creditor_name: "华辰建设有限公司" },
        ];
      }
      return baseQuery(sql, bindings);
    }) as SurrealConn["query"];
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });
    const mappings: TemplateImportMapping[] = [
      { sourceIndex: 0, sourceLabel: "材料名称", targetKey: "material_name", matchedBy: "field-name" },
      { sourceIndex: 1, sourceLabel: "债权人", targetKey: "creditor", matchedBy: "alias" },
    ];

    const first = await runtime.importCsvRows({
      rows: [
        ["送货签收单", "远航供应链有限公司"],
        ["抵押登记", "未登记债权人"],
      ],
      mappings,
    });

    expect(first).toEqual({
      importedCount: 1,
      rejected: [{
        rowNumber: 3,
        field: "关联债权人",
        reason: "未找到显示值为“未登记债权人”的引用记录",
        sourceCells: ["抵押登记", "未登记债权人"],
      }],
    });
    expect(h.creates).toHaveLength(1);
    expect(referenceQueries).toEqual(["SELECT id, creditor_name FROM ent_creditor"]);
    expect(h.creates[0]!.table).toBe("ent_claim");
    expect(String(h.creates[0]!.data.creditor)).toBe("ent_creditor:c1");

    const retry = await runtime.importCsvRows({
      rows: [["抵押登记", "华辰建设有限公司"]],
      rowNumbers: [3],
      mappings,
    });
    expect(retry).toEqual({ importedCount: 1, rejected: [] });
    expect(referenceQueries).toEqual([
      "SELECT id, creditor_name FROM ent_creditor",
      "SELECT id, creditor_name FROM ent_creditor",
    ]);
    expect(h.creates).toHaveLength(2);
    expect(String(h.creates[1]!.data.creditor)).toBe("ent_creditor:c2");
  });
});

describe("数据表运行时 schema mutation", () => {
  test("字段 DDL 与 column_defs 更新使用同一事务", async () => {
    const h = runtimeHarness([{ id: "ent_claim:a", name: "甲", amount: 1 }]);
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    const result = await runtime.updateFields([
      ...columns,
      { key: "note", label: "备注", fieldType: "text" },
    ]);

    expect(result.ok).toBe(true);
    expect(h.txCalls[0]).toBe("BEGIN");
    expect(h.txCalls.some((sql) => /DEFINE FIELD OVERWRITE note/.test(sql))).toBe(true);
    expect(h.updates.at(-1)?.id).toBe("sheet:s1");
    expect(h.txCalls.at(-1)).toBe("COMMIT");
  });

  test("普通字段编辑拒绝同时删旧 key / 加新 key", async () => {
    const h = runtimeHarness();
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    const result = await runtime.updateFields([
      { key: "renamed", label: "名称", fieldType: "text", required: true },
      columns[1],
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect(h.txCalls).toHaveLength(0);
  });

  test("删除字段必须先预检确认，并在同一事务清值、删 schema、更新元数据", async () => {
    const h = runtimeHarness([{ id: "ent_claim:a", name: "甲", amount: 1 }]);
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    const direct = await runtime.updateFields([columns[0]]);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error.code).toBe("conflict");

    const planned = await runtime.planFieldRemoval("amount");
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.affectedRecordCount).toBe(1);

    const confirmed = await runtime.confirmFieldRemoval(planned.value.token);
    expect(confirmed.ok).toBe(true);
    expect(h.txCalls.some((sql) => /UPDATE ent_claim UNSET amount/.test(sql))).toBe(true);
    expect(h.txCalls.some((sql) => /REMOVE FIELD IF EXISTS amount/.test(sql))).toBe(true);
    expect(h.updates.at(-1)?.id).toBe("sheet:s1");
    expect(h.txCalls.at(-1)).toBe("COMMIT");
  });
});

describe("数据表运行时关闭", () => {
  test("close 取消 LIVE，之后写入返回 closed", async () => {
    const h = runtimeHarness();
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });

    await runtime.close();
    expect(h.unsubscribed).toBe(true);
    const result = await runtime.updateRecords([{ id: "ent_claim:a", values: { name: "x" } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("closed");
  });
});
