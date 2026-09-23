import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import type { ParsedXlsxSheet } from "./xlsx-import";
import { createWorkbooksStore } from "./workbooks";

function readySheet(
  name: string,
  fields: ParsedXlsxSheet["fields"],
  rows: string[][],
): ParsedXlsxSheet {
  return { name, status: "ready", issue: null, fields, rows, previewRows: rows.slice(0, 20) };
}

function setup(createThrows?: unknown) {
  const queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  let key = 0;
  const conn = {
    query: async (sql: string, bindings?: Record<string, unknown>) => {
      queries.push({ sql, bindings });
      if (createThrows) throw createThrows;
      return [];
    },
  } as unknown as SurrealConn;
  const store = createWorkbooksStore({
    getConn: () => conn,
    generateKey: () => String(++key).padStart(16, "0"),
  });
  return { queries, store };
}

describe("OIP-13 workbooksStore.importXlsxWorkbook", () => {
  test("一个事务原子创建工作簿、多个数据表及各自合法记录", async () => {
    const { queries, store } = setup();
    const result = await store.importXlsxWorkbook({
      workbookName: "历史案件",
      sheets: [
        readySheet("债权", [
          { key: "field_1", label: "债权人", fieldType: "text", sourceIndex: 0 },
          { key: "field_2", label: "申报金额", fieldType: "decimal", sourceIndex: 1 },
        ], [["甲公司", "1,000"], ["乙公司", "待核"]]),
        readySheet("材料", [
          { key: "field_1", label: "材料名称", fieldType: "text", sourceIndex: 0 },
        ], [["合同"], [""]]),
      ],
    });

    expect(result?.workbook).toEqual({
      id: "workbook:0000000000000001",
      name: "历史案件",
      templateRef: undefined,
    });
    expect(result?.sheets).toEqual([
      {
        sheetName: "债权",
        importedCount: 1,
        skippedCount: 1,
        rejected: [{ rowNumber: 3, field: "整条记录", reason: "字段“申报金额”不是有效金额/小数", sourceCells: ["乙公司", "待核"] }],
      },
      {
        sheetName: "材料",
        importedCount: 1,
        skippedCount: 1,
        rejected: [{ rowNumber: 3, field: "整条记录", reason: "空白记录", sourceCells: [""] }],
      },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/^BEGIN TRANSACTION;/u);
    expect(queries[0]!.sql.match(/DEFINE TABLE IF NOT EXISTS ent_/gu)).toHaveLength(2);
    expect(queries[0]!.sql).toMatch(/COMMIT TRANSACTION;$/u);
    expect(Object.values(queries[0]!.bindings ?? {}).filter((value) =>
      typeof value === "object" && value !== null && "field_1" in value)).toEqual([
      { field_1: "甲公司", field_2: 1000 },
      { field_1: "合同" },
    ]);
  });

  test("任一结构创建失败时不暴露半成品工作簿", async () => {
    const { store } = setup(new Error("Not allowed to define table"));
    const result = await store.importXlsxWorkbook({
      workbookName: "历史案件",
      sheets: [readySheet("债权", [
        { key: "field_1", label: "名称", fieldType: "text", sourceIndex: 0 },
      ], [["甲公司"]])],
    });

    expect(result).toBeNull();
    expect(store.workbooks).toEqual([]);
    expect(store.error).toBe("没有权限执行该操作（仅工作区管理员可修改表结构）");
  });

  test("持久批次的新工作簿在同一原子事务写业务记录与逐行回执", async () => {
    const { queries, store } = setup();
    const result = await store.importXlsxWorkbook({
      workbookName: "历史案件",
      batch: { id: "import_batch:b1" },
      sheets: [readySheet("债权", [
        { key: "field_1", label: "名称", fieldType: "text", sourceIndex: 0 },
        { key: "field_2", label: "金额", fieldType: "decimal", sourceIndex: 1 },
      ], [["甲公司", "100"], ["乙公司", "待核"]])],
    });

    expect(result?.sheets[0]).toMatchObject({ importedCount: 1, skippedCount: 1 });
    const transaction = queries[0]!;
    expect(transaction.sql.match(/INSERT INTO import_batch_row/gu)).toHaveLength(2);
    expect(transaction.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(transaction.sql).toContain("UPDATE import_batch SET workbook = workbook:");
    expect(transaction.sql).toContain("UPDATE import_batch_sheet SET target_sheet = sheet:");
    expect(transaction.bindings).toEqual(expect.objectContaining({
      importBatchWorkbook: expect.anything(),
      importBatchSheetName0: "债权",
      importBatch0: expect.anything(),
      importSheetName0: "债权",
      importRowNumber0: 2,
      importRowStatus0: "success",
      importSheetName1: "债权",
      importRowNumber1: 3,
      importRowStatus1: "rejected",
      importRowReason1: expect.stringContaining("金额"),
    }));
  });
});
