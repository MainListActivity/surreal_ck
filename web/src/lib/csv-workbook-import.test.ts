import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import { parseCsvImport } from "./csv-import";
import { createWorkbooksStore } from "./workbooks";

function setup(createThrows?: unknown) {
  const queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  const keys = [
    "1111111111111111",
    "2222222222222222",
    "3333333333333333",
    "4444444444444444",
  ];
  const conn = {
    query: async (sql: string, bindings?: Record<string, unknown>) => {
      queries.push({ sql, bindings });
      if (/BEGIN TRANSACTION/i.test(sql) && createThrows) throw createThrows;
      return [];
    },
  } as unknown as SurrealConn;
  const store = createWorkbooksStore({ getConn: () => conn, generateKey: () => keys.shift()! });
  return { queries, store };
}

describe("workbooksStore.importCsvWorkbook — CSV 新工作簿原子导入", () => {
  test("只提交一个事务并返回成功、跳过和字段识别结果", async () => {
    const { queries, store } = setup();
    const parsed = parseCsvImport(
      "债权人名称,申报金额,申报日期\n甲公司,1000,2026-07-01\n乙公司,待确认,2026-07-02\n,,",
      "历史债权.csv",
    );
    const fields = parsed.fields.map((field) =>
      field.label === "申报金额" ? { ...field, fieldType: "decimal" as const } : field
    );

    const result = await store.importCsvWorkbook({
      workbookName: parsed.workbookName,
      sheetLabel: "历史债权",
      fields,
      rows: parsed.rows,
    });

    expect(result).toEqual({
      workbook: { id: "workbook:1111111111111111", name: "历史债权", templateRef: undefined },
      importedCount: 1,
      skippedCount: 2,
      fields: [
        { label: "债权人名称", fieldType: "text" },
        { label: "申报金额", fieldType: "decimal" },
        { label: "申报日期", fieldType: "date" },
      ],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/^BEGIN TRANSACTION;/);
    expect(queries[0]!.sql).toContain("CREATE ent_1111111111111111_main:3333333333333333 CONTENT $sampleRecord0");
    expect(queries[0]!.sql).toMatch(/COMMIT TRANSACTION;$/);
    expect(queries[0]!.bindings?.sampleRecord0).toEqual({
      field_1: "甲公司",
      field_2: 1000,
      field_3: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(store.workbooks).toEqual([result!.workbook]);
  });

  test("数据库拒绝 participant DDL 时显示管理员权限提示且不加入工作簿列表", async () => {
    const { queries, store } = setup(new Error("IAM error: Not allowed to define table"));
    const parsed = parseCsvImport("名称\n甲公司", "债权.csv");

    const result = await store.importCsvWorkbook({
      workbookName: parsed.workbookName,
      sheetLabel: "债权",
      fields: parsed.fields,
      rows: parsed.rows,
    });

    expect(result).toBeNull();
    expect(queries).toHaveLength(1);
    expect(store.error).toBe("没有权限执行该操作（仅工作区管理员可修改表结构）");
    expect(store.workbooks).toEqual([]);
  });
});
