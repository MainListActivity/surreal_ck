import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import {
  buildLegacyQuotaCleanupSurql,
  buildLegacyQuotaGuardResidualSurql,
  buildRecordQuotaGuardSurql,
} from "./resource-quota";

describe("resource quota public contract", () => {
  test("为动态实体表生成绑定数据表身份的记录配额事件", () => {
    const sql = buildRecordQuotaGuardSurql({
      tableName: "ent_a1b2_main",
      sheetId: new StringRecordId("sheet:c3d4"),
    });

    expect(sql).toContain("DEFINE EVENT OVERWRITE resource_quota_guard ON TABLE ent_a1b2_main");
    expect(sql).toContain("sheet = sheet:c3d4");
    expect(sql).toContain('"quota-records-exceeded"');
    expect(sql).toContain('WHEN $event = "CREATE" OR $event = "DELETE"');
  });

  test("事件体由 record::exists 哨兵包裹，legacy 记账表缺失时自动失效", () => {
    const sql = buildRecordQuotaGuardSurql({
      tableName: "ent_a1b2_main",
      sheetId: new StringRecordId("sheet:c3d4"),
    });

    // 点查不命中表定义检查：021 清理后表被移除，残留事件返回 false 而非抛错。
    expect(sql).toContain("IF record::exists(workspace_resource_quota:current)");
    expect(sql.indexOf("record::exists")).toBeLessThan(sql.indexOf("UPDATE sheet_resource_usage"));
  });

  test("拒绝把不安全的动态表名或数据表 RecordId 拼进 DDL", () => {
    expect(() => buildRecordQuotaGuardSurql({
      tableName: "ent_ok; REMOVE DATABASE main",
      sheetId: new StringRecordId("sheet:c3d4"),
    })).toThrow("invalid entity table name");
    expect(() => buildRecordQuotaGuardSurql({
      tableName: "ent_ok",
      sheetId: new StringRecordId("workbook:c3d4"),
    })).toThrow("invalid sheet record id");
  });

  test("legacy cleanup 先显式移除全部动态 guard，再在同一事务删除支撑表", () => {
    const sql = buildLegacyQuotaCleanupSurql([
      "ent_beta",
      "ent_alpha",
      "ent_alpha",
    ]);

    expect(sql.match(/REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_alpha/g)).toHaveLength(1);
    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_beta",
    );
    expect(sql.indexOf("ON TABLE ent_beta")).toBeLessThan(
      sql.indexOf("REMOVE TABLE IF EXISTS sheet_resource_usage"),
    );
    expect(sql).toMatch(/^BEGIN TRANSACTION;/u);
    expect(sql).toMatch(/COMMIT TRANSACTION;$/u);
    expect(() =>
      buildLegacyQuotaCleanupSurql(["ent_ok; REMOVE DATABASE main"])
    ).toThrow("invalid legacy quota table name");
  });

  test("residual sweep 只移除残留 guard，不触碰任何表或数据", () => {
    const sql = buildLegacyQuotaGuardResidualSurql(["ent_beta", "ent_alpha"]);

    expect(sql).toContain("REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_alpha");
    expect(sql).toContain("REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_beta");
    expect(sql).toContain("REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE sheet");
    expect(sql).not.toContain("REMOVE TABLE");
    expect(sql).toMatch(/^BEGIN TRANSACTION;/u);
    expect(sql).toMatch(/COMMIT TRANSACTION;$/u);
    expect(() =>
      buildLegacyQuotaGuardResidualSurql(["ent_ok; REMOVE DATABASE main"])
    ).toThrow("invalid residual quota guard table name");
  });

  test("sheet.table_name 不限于 ent_ 前缀：qa_* 等合法标识符照常清扫", () => {
    const sql = buildLegacyQuotaGuardResidualSurql([
      "qa_ver03_materials",
      "ent_alpha_main",
    ]);

    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE qa_ver03_materials",
    );
    expect(sql).toContain(
      "REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ent_alpha_main",
    );
    const cleanup = buildLegacyQuotaCleanupSurql(["qa_ver03_materials"]);
    expect(cleanup).toContain("ON TABLE qa_ver03_materials");
  });
});
