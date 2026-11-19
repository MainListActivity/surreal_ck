import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import { parseCsvImport } from "./csv-import";
import type { ParsedXlsxSheet } from "./xlsx-import";
import { createWorkbooksStore } from "./workbooks";

const KEYS = Array.from({ length: 8 }, (_, index) => `000000000000000${index + 1}`.slice(-16));

function setup() {
  const flags = { failRead: false, failWrite: false };
  const queries: string[] = [];
  const conn = {
    query: async (sql: string) => {
      queries.push(sql);
      if (flags.failRead && /SELECT \* FROM workbook/i.test(sql)) throw new Error("列表读取失败");
      if (flags.failWrite && /BEGIN TRANSACTION/i.test(sql)) throw new Error("IAM error: Not allowed to define table");
      return [];
    },
  } as unknown as SurrealConn;
  const store = createWorkbooksStore({
    getConn: () => conn,
    generateKey: () => KEYS.shift()!,
  });
  return { flags, queries, store };
}

const PERMISSION_MESSAGE = "没有权限执行该操作（仅工作区管理员可修改表结构）";

describe("导入错误归属向导作用域", () => {
  test("建表权限拒绝只写 importError，首页 error 与列表不变", async () => {
    const { flags, store } = setup();
    flags.failRead = true;
    await store.load();
    const pageError = store.error;
    expect(pageError).toBe("Error: 列表读取失败");

    flags.failWrite = true;
    const parsed = parseCsvImport("姓名\n张三", "成员.csv");
    const result = await store.importCsvWorkbook({
      workbookName: parsed.workbookName,
      sheetLabel: "成员",
      fields: parsed.fields,
      rows: parsed.rows,
    });

    expect(result).toBeNull();
    expect(store.importError).toBe(PERMISSION_MESSAGE);
    expect(store.error).toBe(pageError);
    expect(store.workbooks).toEqual([]);
  });

  test("关闭向导只清 importError，不抹掉页面已有错误", async () => {
    const { flags, store } = setup();
    flags.failRead = true;
    await store.load();
    const pageError = store.error;

    flags.failWrite = true;
    const parsed = parseCsvImport("姓名\n张三", "成员.csv");
    await store.importCsvWorkbook({
      workbookName: parsed.workbookName,
      sheetLabel: "成员",
      fields: parsed.fields,
      rows: parsed.rows,
    });
    expect(store.importError).toBe(PERMISSION_MESSAGE);

    store.clearImportError();

    expect(store.importError).toBeNull();
    expect(store.error).toBe(pageError);
  });

  test("参数校验失败同样落向导作用域，下一次导入成功后清空", async () => {
    const { flags, store } = setup();
    const parsed = parseCsvImport("姓名\n张三", "成员.csv");

    const invalid = await store.importCsvWorkbook({
      workbookName: "   ",
      sheetLabel: "成员",
      fields: parsed.fields,
      rows: parsed.rows,
    });
    expect(invalid).toBeNull();
    expect(store.importError).toBe("工作簿名称不能为空");
    expect(store.error).toBeNull();

    flags.failWrite = true;
    await store.importCsvWorkbook({
      workbookName: parsed.workbookName,
      sheetLabel: "成员",
      fields: parsed.fields,
      rows: parsed.rows,
    });
    expect(store.importError).toBe(PERMISSION_MESSAGE);

    flags.failWrite = false;
    const success = await store.importCsvWorkbook({
      workbookName: parsed.workbookName,
      sheetLabel: "成员",
      fields: parsed.fields,
      rows: parsed.rows,
    });
    expect(success).not.toBeNull();
    expect(store.importError).toBeNull();
  });

  test("XLSX 新建工作簿失败也落 importError", async () => {
    const { flags, store } = setup();
    flags.failWrite = true;
    const sheet: ParsedXlsxSheet = {
      name: "成员",
      status: "ready",
      issue: null,
      fields: [{ key: "field_1", label: "姓名", sourceIndex: 0, fieldType: "text" }],
      rows: [["张三"]],
      previewRows: [["张三"]],
    };

    const result = await store.importXlsxWorkbook({ workbookName: "成员", sheets: [sheet] });

    expect(result).toBeNull();
    expect(store.importError).toBe(PERMISSION_MESSAGE);
    expect(store.error).toBeNull();
  });
});