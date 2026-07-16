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

  test("已完成的检查日返回 completed，阻止 runner 再读业务记录", async () => {
    const session: EmployeeQuerySession = {
      async query() {
        return [{ status: "completed" }];
      },
    };

    const store = createSurrealClaimsRiskStore(session);

    expect(await store.beginDailyRun("2026-07-17")).toBe("completed");
  });
});
