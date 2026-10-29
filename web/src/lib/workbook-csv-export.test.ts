import { describe, expect, test } from "bun:test";
import type { GridColumnDef, GridRow } from "@surreal-ck/shared/dto";
import type { DataTableRuntime } from "./data-table-runtime";
import type { SheetMeta } from "./editor-store";
import { buildSheetCsv, buildWorkbookCsvFiles } from "./workbook-csv-export";

const columns: GridColumnDef[] = [
  { key: "name", label: "名称", fieldType: "text" },
  { key: "amount", label: "金额", fieldType: "decimal" },
  { key: "due", label: "到期日", fieldType: "date", dateFormat: "YYYY-MM-DD" },
];

function fakeRuntime(rows: GridRow[], closed: string[], tableId: string): DataTableRuntime {
  return {
    snapshot: { status: "ready", dataTableId: tableId, label: "", columns, records: [], query: {
      filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null,
    }, error: null },
    scanAllRecords: async () => ({ records: rows, scannedCount: rows.length, stale: false }),
    close: async () => { closed.push(tableId); },
  } as unknown as DataTableRuntime;
}

const sheetA: SheetMeta = { id: "sheet:a", label: "债权人", tableName: "ent_a", columns };
const sheetB: SheetMeta = { id: "sheet:b", label: "申报", tableName: "ent_b", columns };

describe("buildSheetCsv — 工作簿 CSV 导出", () => {
  test("UTF-8 BOM 开头，CRLF 换行，列头为字段标签", () => {
    const csv = buildSheetCsv(columns, []);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿名称,金额,到期日\r\n");
  });

  test("行数等于记录数，单元格按 RFC 4180 转义", () => {
    const csv = buildSheetCsv(columns, [
      { id: "ent_a:1", values: { name: "甲, 乙", amount: "12.50", due: null } },
      { id: "ent_a:2", values: { name: 'say "hi"', amount: null, due: null } },
      { id: "ent_a:3", values: { name: "多行\n文本", amount: "1", due: null } },
    ]);
    expect(csv).toBe(
      "﻿名称,金额,到期日\r\n"
        + '"甲, 乙",12.50,\r\n'
        + '"say ""hi""",,\r\n'
        + '"多行\n文本",1,\r\n',
    );
  });

  test("日期字段按字段 dateFormat 格式化，与表格展示一致", () => {
    const csv = buildSheetCsv(columns, [
      { id: "ent_a:1", values: { name: "甲", amount: "1", due: "2026-03-05T00:00:00Z" } },
    ]);
    const row = csv.slice(1).split("\r\n")[1];
    expect(row.split(",")[2]).toBe("2026-03-05");
  });
});

describe("buildWorkbookCsvFiles — 逐表读取", () => {
  test("每张表生成一个文件，行数与读到的记录数一致，并关闭 runtime", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const files = await buildWorkbookCsvFiles({
      workbookName: "破产申报",
      sheets: [sheetA, sheetB],
      today: "2026-10-29",
      openRuntime: async (sheet) => {
        opened.push(sheet.id);
        return fakeRuntime(
          sheet.id === "sheet:a"
            ? [{ id: "ent_a:1", values: { name: "甲", amount: "1", due: null } }]
            : [
                { id: "ent_b:1", values: { name: "乙", amount: "2", due: null } },
                { id: "ent_b:2", values: { name: "丙", amount: "3", due: null } },
              ],
          closed,
          sheet.id,
        );
      },
    });

    expect(opened).toEqual(["sheet:a", "sheet:b"]);
    expect(files.map((f) => f.fileName)).toEqual([
      "破产申报-债权人-2026-10-29.csv",
      "破产申报-申报-2026-10-29.csv",
    ]);
    expect(files[0].content.slice(1).split("\r\n").filter(Boolean).length).toBe(2);
    expect(files[1].content.slice(1).split("\r\n").filter(Boolean).length).toBe(3);
    expect(closed).toEqual(["sheet:a", "sheet:b"]);
  });

  test("任一表读取失败则整体抛错，不返回部分文件", async () => {
    await expect(buildWorkbookCsvFiles({
      workbookName: "破产申报",
      sheets: [sheetA, sheetB],
      today: "2026-10-29",
      openRuntime: async (sheet) => {
        if (sheet.id === "sheet:b") throw new Error("数据表不存在或不属于当前工作簿");
        return fakeRuntime([], [], sheet.id);
      },
    })).rejects.toThrow("数据表不存在或不属于当前工作簿");
  });

  test("文件名去掉路径分隔符等非法字符", async () => {
    const files = await buildWorkbookCsvFiles({
      workbookName: "a/b:c",
      sheets: [{ ...sheetA, label: "x?y" }],
      today: "2026-10-29",
      openRuntime: async (sheet) => fakeRuntime([], [], sheet.id),
    });
    expect(files[0].fileName).toBe("a_b_c-x_y-2026-10-29.csv");
  });
});
