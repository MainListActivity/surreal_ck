import { describe, expect, test } from "bun:test";
import type { ClaimsRiskStore } from "./daily-claims-risk";
import {
  ensureClaimsRiskEmployee,
  runClaimsRiskReminderDispatch,
  type RootEmployeeProvisioningSession,
} from "./claims-risk-dispatcher";

describe("OIP-18 风险提醒 dispatcher", () => {
  test("没有专用虚拟员工时以 root 仅创建身份和凭证，并返回后续 SIGNIN 所需目标", async () => {
    let hasEmployee = false;
    let secret: string | undefined;
    const root: RootEmployeeProvisioningSession = {
      async query(sql, params) {
        if (sql.includes("FROM user:claims_risk_reminder")) {
          return hasEmployee ? [{ id: "user:claims_risk_reminder", subject: "claims-risk-reminder" }] : [];
        }
        if (sql.includes("CREATE user:claims_risk_reminder")) {
          hasEmployee = true;
          return [];
        }
        if (sql.includes("FROM employee_credential")) {
          return secret ? [{ secret }] : [];
        }
        if (sql.includes("INSERT INTO employee_credential")) {
          secret = String(params?.secret);
          return [];
        }
        return [];
      },
    };

    expect(await ensureClaimsRiskEmployee(root, () => "generated-secret")).toEqual({
      subject: "claims-risk-reminder",
      secret: "generated-secret",
    });
  });

  test("使用每个目标的 employee store 执行检查并在窗口结束后关闭", async () => {
    const calls: string[] = [];
    const store: ClaimsRiskStore = {
      async loadEnabledWorkbooks() {
        calls.push("employee:load-workbooks");
        return [];
      },
      async beginDailyRun() {
        throw new Error("disabled workspace must not begin");
      },
      async loadSheetRecords() { return []; },
      async saveReminder() { return false; },
      async completeDailyRun() {},
      async failDailyRun() {},
    };

    const result = await runClaimsRiskReminderDispatch({
      now: () => new Date("2026-07-17T01:00:00.000Z"),
      async listEmployees() {
        calls.push("root:list-employees");
        return [{ database: "ws_alpha", subject: "risk-employee", secret: "secret" }];
      },
      async openEmployeeStore(target) {
        calls.push(`employee:open:${target.database}`);
        return {
          store,
          async close() { calls.push("employee:close"); },
        };
      },
    });

    expect(result).toEqual({ targets: 1, completed: 1, failed: 0 });
    expect(calls).toEqual([
      "root:list-employees",
      "employee:open:ws_alpha",
      "employee:load-workbooks",
      "employee:close",
    ]);
  });
});
