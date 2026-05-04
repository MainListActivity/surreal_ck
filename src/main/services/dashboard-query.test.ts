import { describe, expect, test } from "bun:test";
import {
  assessSqlMutationRisk,
  extractSourceTables,
  normalizeDashboardResult,
  validateDashboardSqlShape,
} from "./dashboard-query";
import { ServiceError } from "./errors";

describe("validateDashboardSqlShape", () => {
  test("允许单条 SELECT 并去掉末尾分号", () => {
    const sql = validateDashboardSqlShape("SELECT count() AS value FROM workbook LIMIT 1;", "single_value");
    expect(sql).toBe("SELECT count() AS value FROM workbook LIMIT 1");
  });

  test("拒绝多条语句(form 检查,与 mutation 风险无关)", () => {
    expect(() =>
      validateDashboardSqlShape("SELECT * FROM workbook; SELECT * FROM sheet", "table_rows"),
    ).toThrow(ServiceError);
  });

  test("拒绝非 SELECT/RETURN 起始的 SQL", () => {
    expect(() =>
      validateDashboardSqlShape("DELETE workbook:1", "table_rows"),
    ).toThrow(ServiceError);
  });

  test("行集型 contract 缺少 limit 时拒绝", () => {
    expect(() =>
      validateDashboardSqlShape("SELECT * FROM workbook", "table_rows"),
    ).toThrow(ServiceError);
  });
});

describe("assessSqlMutationRisk", () => {
  test("纯只读 SELECT 不命中风险", () => {
    expect(assessSqlMutationRisk("SELECT * FROM workbook LIMIT 10").keywords).toEqual([]);
  });

  test("命中改数据关键字时返回关键字列表", () => {
    expect(assessSqlMutationRisk("SELECT * FROM workbook; DELETE workbook:1").keywords)
      .toEqual(expect.arrayContaining(["DELETE"]));
    expect(assessSqlMutationRisk("UPDATE workbook SET name = 'x' RETURN AFTER").keywords)
      .toEqual(expect.arrayContaining(["UPDATE"]));
  });

  test("字符串字面量与注释中的关键字不误报", () => {
    expect(assessSqlMutationRisk("SELECT 'i will DELETE you' AS msg FROM workbook LIMIT 1").keywords)
      .toEqual([]);
    expect(assessSqlMutationRisk("SELECT * FROM workbook -- DELETE here\nLIMIT 1").keywords)
      .toEqual([]);
  });
});

describe("extractSourceTables", () => {
  test("提取 from 后的表名", () => {
    const tables = extractSourceTables("SELECT * FROM workbook WHERE id IN (SELECT id FROM sheet LIMIT 5) LIMIT 10");
    expect(tables).toEqual(["workbook", "sheet"]);
  });
});

describe("normalizeDashboardResult", () => {
  test("归一化 single_value 结果", () => {
    const result = normalizeDashboardResult([[{ value: 42 }]], "single_value");
    expect(result).toEqual({ value: 42, label: undefined, unit: undefined, delta: null });
  });

  test("归一化 table_rows 结果", () => {
    const result = normalizeDashboardResult([[{ name: "Alpha", total_count: 3 }]], "table_rows");
    expect("columns" in result).toBe(true);
    if ("columns" in result) {
      expect(result.columns).toEqual([
        { key: "name", label: "Name" },
        { key: "total_count", label: "Total Count" },
      ]);
      expect(result.rows).toEqual([{ name: "Alpha", total_count: 3 }]);
    }
  });
});
