import { describe, expect, test } from "bun:test";
import { createSurrealClaimsRiskStore, type EmployeeQuerySession } from "./surreal-claims-risk-store";

describe("OIP-18 employee SurrealDB store", () => {
  test("只返回已启用的破产债权工作簿及其稳定模板数据表映射", async () => {
    const session: EmployeeQuerySession = {
      async query(sql) {
        if (sql.includes("FROM workbook")) {
          return [{ id: "workbook:claims", name: "债权台账" }];
        }
        if (sql.includes("FROM sheet")) {
          return [
            { template_sheet_key: "creditors", table_name: "ent_claims_creditors" },
            { template_sheet_key: "materials", table_name: "ent_claims_materials" },
            { template_sheet_key: "tasks", table_name: "ent_claims_tasks" },
          ];
        }
        return [];
      },
    };

    const store = createSurrealClaimsRiskStore(session);

    expect(await store.loadEnabledWorkbooks()).toEqual([{
      id: "workbook:claims",
      name: "债权台账",
      sheets: {
        creditors: "ent_claims_creditors",
        materials: "ent_claims_materials",
        tasks: "ent_claims_tasks",
      },
    }]);
  });

  test("提醒显式写 purpose=claims-risk，不依赖 schema 默认值（044 默认桶为 info）", async () => {
    let inserted: Record<string, unknown> | undefined;
    const session: EmployeeQuerySession = {
      async query(sql, params) {
        if (sql.includes("FROM user WHERE")) {
          return [{ id: "user:owner" }];
        }
        if (sql.includes("INSERT INTO user_notification")) {
          inserted = params?.content as Record<string, unknown>;
          return [];
        }
        return [];
      },
    };
    const store = createSurrealClaimsRiskStore(session);

    const saved = await store.saveReminder({
      dedupeKey: "2026-09-30|workbook:claims|ent_claims_materials:m1|missing-material",
      checkDate: "2026-09-30",
      checkedAt: new Date("2026-09-30T01:00:00.000Z"),
      workbookId: "workbook:claims",
      workbookName: "债权台账",
      recordId: "ent_claims_materials:m1",
      riskType: "missing-material",
      title: "材料缺失：签收单",
      body: "缺少三月份签收单",
      severity: "warning",
      matchedFields: { is_missing: true },
      rule: "证据材料记录的“是否缺失”为是",
    });

    expect(saved).toBe(true);
    expect(inserted?.purpose).toBe("claims-risk");
    expect(inserted?.risk_type).toBe("missing-material");
  });

  test("已完成的检查日返回 completed，阻止 runner 再读业务记录", async () => {
    // UPSERT ... WHERE status != "completed"：completed 行不命中 WHERE → 空集 = 已完成。
    const session: EmployeeQuerySession = {
      async query() {
        return [];
      },
    };

    const store = createSurrealClaimsRiskStore(session);

    expect(await store.beginDailyRun("2026-07-17")).toBe("completed");
  });
});
