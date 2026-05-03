import { describe, expect, test } from "bun:test";
import {
  extractSourceTables,
  normalizeDashboardResult,
  validateReadOnlyDashboardSql,
} from "./dashboard-query";
import { ServiceError } from "./errors";

describe("validateReadOnlyDashboardSql", () => {
  test("允许单条 SELECT", () => {
    const sql = validateReadOnlyDashboardSql("SELECT count() AS value FROM workbook LIMIT 1;", "single_value");
    expect(sql).toBe("SELECT count() AS value FROM workbook LIMIT 1");
  });

  test("拒绝写操作关键字", () => {
    expect(() =>
      validateReadOnlyDashboardSql("SELECT * FROM workbook; DELETE workbook:1", "table_rows"),
    ).toThrow(ServiceError);
  });

  test("行集型 contract 缺少 limit 时拒绝", () => {
    expect(() =>
      validateReadOnlyDashboardSql("SELECT * FROM workbook", "table_rows"),
    ).toThrow(ServiceError);
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
