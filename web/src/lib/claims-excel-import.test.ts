import { describe, expect, test } from "bun:test";
import {
  buildLedgerXlsx,
  buildRosterXlsx,
  formatClaimsImportSummary,
  importCreditorRoster,
  importEnterpriseLedger,
  parseLedgerWorkbook,
  parseRosterWorkbook,
  validateLedgerRows,
  validateRosterRows,
  type ClaimsImportWriteResult,
} from "./claims-excel-import";
import type { SurrealConn } from "./surreal";

function rosterRows(extra: Array<Array<string | number>> = []): string[][] {
  return [
    ["主体类型", "名称", "唯一识别码", "对接联系人", "联系方式"],
    ["企业", "华辰建设有限公司", "91320100MA01HC001X", "张明", "13800001001"],
    ["个人", "李某", "320102198805120018", "李某", "13800001003"],
    ...extra.map((row) => row.map(String)),
  ];
}

function ledgerRows(extra: Array<Array<string | number>> = []): string[][] {
  return [
    ["唯一识别码", "本金", "账面利息", "合同引用", "备注"],
    ["91320100MA01HC001X", "100000", "5000", "合同-001", ""],
    ...extra.map((row) => row.map(String)),
  ];
}

describe("claims excel 逐行校验", () => {
  test("企业缺对接联系人：拒绝并给出行号；合法行仍接受（部分成功）", () => {
    const result = validateRosterRows(rosterRows([
      ["企业", "缺联系人公司", "91320100MA01HC002Y", "", "13900000000"],
    ]));
    expect(result.accepted.map((row) => row.record.identity_code)).toEqual([
      "91320100MA01HC001X",
      "320102198805120018",
    ]);
    expect(result.rejected).toEqual([
      { rowNumber: 4, field: "contact_name", reason: "企业行必须填写对接联系人" },
    ]);
  });

  test("个人行不要求对接联系人", () => {
    const result = validateRosterRows([
      ["主体类型", "名称", "唯一识别码", "对接联系人", "联系方式"],
      ["个人", "王某", "320102199001010011", "", ""],
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.record.contact_name).toBeNull();
  });

  test("识别码空或文件内重复：拒绝并给出行号", () => {
    const result = validateRosterRows([
      ["主体类型", "名称", "唯一识别码", "对接联系人", "联系方式"],
      ["企业", "甲", "", "张", "1"],
      ["企业", "乙", "CODE-1", "李", "2"],
      ["个人", "丙", "CODE-1", "丙", "3"],
    ]);
    expect(result.accepted.map((row) => row.rowNumber)).toEqual([3]);
    expect(result.rejected).toEqual([
      { rowNumber: 2, field: "identity_code", reason: "唯一识别码不能为空" },
      { rowNumber: 4, field: "identity_code", reason: "唯一识别码在本文件名册内重复" },
    ]);
  });

  test("识别码与库内已有冲突：拒绝并给出行号", () => {
    const result = validateRosterRows(rosterRows(), new Set(["91320100MA01HC001X"]));
    expect(result.accepted.map((row) => row.record.identity_code)).toEqual(["320102198805120018"]);
    expect(result.rejected).toEqual([
      { rowNumber: 2, field: "identity_code", reason: "唯一识别码与名册已有行冲突" },
    ]);
  });

  test("账面识别码不在名册：拒绝并给出行号", () => {
    const result = validateLedgerRows(ledgerRows([
      ["UNKNOWN-CODE", "1", "0", "", ""],
      ["91320100MA01HC001X", "-1", "0", "", ""],
      ["91320100MA01HC001X", "abc", "0", "", ""],
    ]), new Set(["91320100MA01HC001X"]));
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.record.principal).toBe(100000);
    expect(result.rejected).toEqual([
      { rowNumber: 3, field: "identity_code", reason: "唯一识别码不在名册中" },
      { rowNumber: 4, field: "principal", reason: "本金不能为负数" },
      { rowNumber: 5, field: "principal", reason: "本金须为非负数字" },
    ]);
  });

  test("至少各一行成功：名册企业+个人，账面一条", () => {
    const roster = validateRosterRows(rosterRows());
    expect(roster.rejected).toEqual([]);
    expect(roster.accepted).toHaveLength(2);
    const ledger = validateLedgerRows(ledgerRows(), new Set(
      roster.accepted.map((row) => row.record.identity_code),
    ));
    expect(ledger.rejected).toEqual([]);
    expect(ledger.accepted).toHaveLength(1);
  });

  test("200 行名册导入校验跑通", () => {
    const dataRows: Array<Array<string | number>> = [];
    for (let i = 0; i < 200; i += 1) {
      const isEnterprise = i % 2 === 0;
      dataRows.push([
        isEnterprise ? "企业" : "个人",
        `债权人-${i}`,
        `ID-${String(i).padStart(4, "0")}`,
        isEnterprise ? `联系人-${i}` : "",
        `138${String(i).padStart(8, "0")}`,
      ]);
    }
    const result = validateRosterRows([
      ["主体类型", "名称", "唯一识别码", "对接联系人", "联系方式"],
      ...dataRows.map((row) => row.map(String)),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(200);
  });

  test("xlsx 解析保留工作表名与表头，行号从 2 起", () => {
    const rosterBuffer = buildRosterXlsx([
      ["企业", "示例公司", "CODE-A", "张三", "1"],
    ]);
    const rosterParsed = parseRosterWorkbook(rosterBuffer);
    expect(rosterParsed[0]).toEqual(["主体类型", "名称", "唯一识别码", "对接联系人", "联系方式"]);
    expect(validateRosterRows(rosterParsed).accepted[0]!.rowNumber).toBe(2);

    const ledgerBuffer = buildLedgerXlsx([
      ["CODE-A", 10, 1, "c", "n"],
    ]);
    const ledgerParsed = parseLedgerWorkbook(ledgerBuffer);
    expect(ledgerParsed[0]?.[0]).toBe("唯一识别码");
    expect(validateLedgerRows(ledgerParsed, new Set(["CODE-A"])).accepted[0]!.rowNumber).toBe(2);
  });

  test("摘要文案包含行号", () => {
    const summary = formatClaimsImportSummary({
      importedCount: 1,
      rejected: [{ rowNumber: 4, field: "contact_name", reason: "企业行必须填写对接联系人" }],
    });
    expect(summary).toContain("第 4 行");
    expect(summary).toContain("成功 1 行");
  });
});

describe("claims excel 写入（假连接）", () => {
  function createFakeConn(seedCodes: string[] = []) {
    const created: Array<{ table: string; data: Record<string, unknown> }> = [];
    const sheets: Array<{ id: string; workbook: string; table_name: string }> = [];
    const queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];

    const conn = {
      async query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
        queries.push({ sql, bindings });
        if (/FROM type::table\(\$tb\)/i.test(sql) && bindings?.tb === "creditor_roster") {
          return seedCodes.map((identity_code) => ({ identity_code })) as T[];
        }
        if (/FROM sheet WHERE table_name INSIDE/i.test(sql)) {
          return sheets as T[];
        }
        if (/BEGIN TRANSACTION/i.test(sql)) {
          if (bindings?.rosterTable === "creditor_roster") {
            sheets.push({
              id: "sheet:roster",
              workbook: "workbook:claims",
              table_name: "creditor_roster",
            });
          }
          if (bindings?.ledgerTable === "enterprise_ledger") {
            sheets.push({
              id: "sheet:ledger",
              workbook: "workbook:claims",
              table_name: "enterprise_ledger",
            });
          }
          return [] as T[];
        }
        return [] as T[];
      },
      async createRecord(table: string, data: Record<string, unknown>) {
        created.push({ table, data });
        return { id: `${table}:${created.length}`, ...data };
      },
      async transaction<T>(run: (tx: SurrealConn) => Promise<T>): Promise<T> {
        return run(conn as unknown as SurrealConn);
      },
    } as unknown as SurrealConn;

    return { conn, created, sheets, queries };
  }

  test("导入名册写入合法行并确保工作簿 sheet 指向 SCHEMAFULL 表", async () => {
    const fake = createFakeConn();
    const buffer = buildRosterXlsx([
      ["企业", "华辰", "CODE-OK", "张明", "138"],
      ["企业", "坏行", "CODE-BAD", "", "139"],
      ["个人", "李某", "CODE-P", "", ""],
    ]);
    const result: ClaimsImportWriteResult = await importCreditorRoster(fake.conn, buffer, {
      generateKey: (() => {
        let n = 0;
        return () => `k${++n}`;
      })(),
    });
    expect(result.importedCount).toBe(2);
    expect(result.rejected).toEqual([
      { rowNumber: 3, field: "contact_name", reason: "企业行必须填写对接联系人" },
    ]);
    expect(fake.created.map((row) => row.data.identity_code)).toEqual(["CODE-OK", "CODE-P"]);
    expect(result.workbookId).toBeTruthy();
    expect(fake.queries.some((q) => /table_name: \$rosterTable/.test(q.sql) || q.bindings?.rosterTable === "creditor_roster")).toBe(true);
  });

  test("导入账面拒绝名册外识别码，成功行写入 enterprise_ledger", async () => {
    const fake = createFakeConn(["CODE-OK"]);
    fake.sheets.push(
      { id: "sheet:roster", workbook: "workbook:claims", table_name: "creditor_roster" },
      { id: "sheet:ledger", workbook: "workbook:claims", table_name: "enterprise_ledger" },
    );
    const buffer = buildLedgerXlsx([
      ["CODE-OK", 100, 1, "c1", ""],
      ["MISSING", 50, 0, "", ""],
    ]);
    const result = await importEnterpriseLedger(fake.conn, buffer);
    expect(result.importedCount).toBe(1);
    expect(result.rejected[0]).toMatchObject({ rowNumber: 3, field: "identity_code" });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.table).toBe("enterprise_ledger");
    expect(fake.created[0]!.data.principal).toBe(100);
  });
});
