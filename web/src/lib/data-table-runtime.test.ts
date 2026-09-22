import { describe, expect, test } from "bun:test";
import type { GridColumnDef, ViewParams } from "@surreal-ck/shared/dto";
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
  const importReceipts = new Map<string, Record<string, unknown>>();

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
    query: (async (sql: string, bindings?: Record<string, unknown>) => {
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
      if (/FROM import_batch_row/i.test(sql)) {
        const key = `${String(bindings?.batch)}:${String(bindings?.sheetName)}:${String(bindings?.rowNumber)}`;
        const receipt = importReceipts.get(key);
        return receipt ? [{ ...receipt }] : [];
      }
      if (/SELECT count\(\) AS total/i.test(sql)) return [{ total: rows.length }];
      if (/SELECT updated_at .*ORDER BY updated_at DESC/i.test(sql)) {
        return rows.length ? [{ updated_at: rows.at(-1)?.updated_at ?? "2026-09-22T00:00:00Z" }] : [];
      }
      if (/FROM type::table/i.test(sql)) {
        const limit = Number(sql.match(/LIMIT (\d+)/i)?.[1] ?? rows.length);
        const start = Number(sql.match(/START (\d+)/i)?.[1] ?? 0);
        return rows.slice(start, start + limit).map((row) => ({ ...row }));
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
        query: (async (sql: string, bindings?: Record<string, unknown>) => {
          txCalls.push(sql);
          if (/CREATE \$targetRecord/i.test(sql)) {
            const created = { id: bindings?.targetRecord, ...(bindings?.data as Record<string, unknown>) };
            creates.push({ table: "ent_claim", data: bindings?.data as Record<string, unknown> });
            rows.push(created);
            return [created];
          }
          if (/INSERT INTO import_batch_row/i.test(sql)) {
            const key = `${String(bindings?.batch)}:${String(bindings?.sheetName)}:${String(bindings?.rowNumber)}`;
            const receipt = {
              id: `import_batch_row:${importReceipts.size + 1}`,
              batch: bindings?.batch,
              sheet_name: bindings?.sheetName,
              source_row_number: bindings?.rowNumber,
              status: bindings?.status,
              target_record: bindings?.targetRecord,
            };
            importReceipts.set(key, receipt);
            return [receipt];
          }
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
    importReceipts,
    get live() { return live; },
    get unsubscribed() { return unsubscribed; },
    setRows(next: Array<Record<string, unknown>>) { rows = next.map((row) => ({ ...row })); },
  };
}

describe("数据表运行时打开与记录入口", () => {
  test("全范围扫描跨过默认 500 条窗口并保留末尾记录", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `ent_claim:r${index + 1}`,
      name: index === 500 ? null : `记录 ${index + 1}`,
      amount: index,
      updated_at: "2026-09-22T00:00:00Z",
    }));
    const h = runtimeHarness(rows);
    const runtime = await openDataTableRuntime({
      conn: h.conn, workbookId: "workbook:w1", dataTableId: "sheet:s1", query: emptyView,
    });

    const scanned = await runtime.scanAllRecords();

    expect(scanned.scannedCount).toBe(501);
    expect(scanned.records.at(-1)).toMatchObject({ id: "ent_claim:r501", values: { name: null } });
    expect(scanned.stale).toBe(false);
  });

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

  test("原生 quota error 保留草稿语义并按 participant 裁剪全表计数", async () => {
    const h = runtimeHarness();
    h.conn.createRecord = async () => {
      throw Object.assign(new Error("message wording is not parsed"), {
        kind: "Quota",
        details: {
          code: "quota_exceeded",
          retryable: false,
          details: {
            violations: [
              {
                resource: "record",
                table: "ent_claim",
                rule_ids: ["secret-rule"],
                limit: 10,
                current: 10,
                delta: 1,
                projected: 11,
                over_by: 1,
              },
              {
                resource: "field",
                table: "private_table",
                rule_ids: ["other-secret"],
                limit: 2,
                current: 2,
                delta: 1,
                projected: 3,
                over_by: 1,
              },
            ],
          },
        },
      });
    };
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
      quotaViewer: { kind: "participant" },
    });
    const result = await runtime.promoteDraft({ name: "保留我", amount: 2 });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toMatchObject({
      code: "quota-exceeded",
      retryable: false,
      message: expect.stringContaining("草稿已保留"),
      quotaFailure: {
        kind: "exceeded",
        preserve_draft: true,
        transaction_committed: false,
        violations: [{ resource: "record", table: "ent_claim" }],
      },
    });
    expect(JSON.stringify(result.error)).not.toContain("private_table");
    expect(JSON.stringify(result.error)).not.toContain("secret-rule");
    expect(JSON.stringify(result.error)).not.toContain('"current":10');
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

  test("持久批次把业务记录与成功回执同事务提交，并在重放前核实回执", async () => {
    const h = runtimeHarness();
    const runtime = await openDataTableRuntime({
      conn: h.conn,
      workbookId: "workbook:w1",
      dataTableId: "sheet:s1",
      query: emptyView,
    });
    const input = {
      rows: [["甲", "100"]],
      rowNumbers: [8],
      mappings: [
        { sourceIndex: 0, sourceLabel: "名称", targetKey: "name", matchedBy: "field-name" },
        { sourceIndex: 1, sourceLabel: "金额", targetKey: "amount", matchedBy: "field-name" },
      ] satisfies TemplateImportMapping[],
      batch: { id: "import_batch:b1", sheetName: "债权" },
    };

    const first = await runtime.importCsvRows(input);
    const replay = await runtime.importCsvRows(input);

    expect(first).toEqual({ importedCount: 1, rejected: [], replayedCount: 0, outcomeUnknownCount: 0 });
    expect(replay).toEqual({ importedCount: 1, rejected: [], replayedCount: 1, outcomeUnknownCount: 0 });
    expect(h.creates).toHaveLength(1);
    expect(h.importReceipts.size).toBe(1);
    expect(h.txCalls.filter((call) => call === "BEGIN")).toHaveLength(1);
    expect(h.txCalls.some((call) => /INSERT INTO import_batch_row/i.test(call))).toBe(true);
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
