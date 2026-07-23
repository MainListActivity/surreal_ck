import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import {
  RESOURCE_QUOTA_PLANS,
  buildRecordQuotaGuardSurql,
} from "./resource-quota";

describe("resource quota public contract", () => {
  test("Plus / Pro / Max 的三类额度严格递增", () => {
    expect(RESOURCE_QUOTA_PLANS).toEqual({
      plus: { maxSheets: 1, maxFieldsPerSheet: 3, maxRecordsPerSheet: 2 },
      pro: { maxSheets: 2, maxFieldsPerSheet: 6, maxRecordsPerSheet: 4 },
      max: { maxSheets: 3, maxFieldsPerSheet: 9, maxRecordsPerSheet: 6 },
    });
  });

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
});
