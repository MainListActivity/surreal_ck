import { describe, expect, test } from "bun:test";
import {
  runDailyClaimsRiskCheck,
  type ClaimsRiskStore,
  type DailyRunState,
  type RiskReminder,
} from "./daily-claims-risk";

class MemoryRiskStore implements ClaimsRiskStore {
  private readonly completedDays = new Set<string>();
  readonly saved: RiskReminder[] = [];
  failNextLoad = false;
  failNextSheetLoad = false;
  failedRuns = 0;
  begunRuns = 0;
  workbooks: Awaited<ReturnType<ClaimsRiskStore["loadEnabledWorkbooks"]>> = [];
  recordsByTable = new Map<string, Array<Record<string, unknown>>>();

  async beginDailyRun(checkDate: string): Promise<DailyRunState> {
    this.begunRuns += 1;
    return this.completedDays.has(checkDate) ? "completed" : "acquired";
  }

  async loadEnabledWorkbooks() {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("temporary database failure");
    }
    return this.workbooks;
  }

  async loadSheetRecords(tableName: string) {
    if (this.failNextSheetLoad) {
      this.failNextSheetLoad = false;
      throw new Error("temporary database failure");
    }
    return this.recordsByTable.get(tableName) ?? [];
  }

  async saveReminder(reminder: RiskReminder) {
    this.saved.push(reminder);
    return true;
  }

  async completeDailyRun(checkDate: string) {
    this.completedDays.add(checkDate);
  }

  async failDailyRun() {
    this.failedRuns += 1;
  }
}

describe("OIP-18 每日债权风险提醒", () => {
  test("同一工作区同一天成功完成后不再重复检查", async () => {
    const store = new MemoryRiskStore();
    store.workbooks = [{ id: "workbook:claims", name: "债权台账", sheets: {} }];
    const checkedAt = new Date("2026-07-17T01:00:00.000Z");

    const first = await runDailyClaimsRiskCheck(store, { checkDate: "2026-07-17", checkedAt });
    const second = await runDailyClaimsRiskCheck(store, { checkDate: "2026-07-17", checkedAt });

    expect(first).toEqual({ status: "completed", remindersCreated: 0 });
    expect(second).toEqual({ status: "already-completed", remindersCreated: 0 });
  });

  test("当天检查失败后下一执行窗口可以重试", async () => {
    const store = new MemoryRiskStore();
    store.workbooks = [{ id: "workbook:claims", name: "债权台账", sheets: { materials: "materials" } }];
    const input = { checkDate: "2026-07-17", checkedAt: new Date("2026-07-17T01:00:00.000Z") };
    store.failNextSheetLoad = true;

    await expect(runDailyClaimsRiskCheck(store, input)).rejects.toThrow("temporary database failure");
    expect(store.failedRuns).toBe(1);
    expect(await runDailyClaimsRiskCheck(store, input)).toEqual({ status: "completed", remindersCreated: 0 });
  });

  test("没有安装并启用债权提醒的工作区直接跳过且不占用今日运行", async () => {
    const store = new MemoryRiskStore();

    const result = await runDailyClaimsRiskCheck(store, {
      checkDate: "2026-07-17",
      checkedAt: new Date("2026-07-17T01:00:00.000Z"),
    });

    expect(result).toEqual({ status: "not-enabled", remindersCreated: 0 });
    expect(store.begunRuns).toBe(0);
  });

  test("缺失材料生成包含命中字段和规则依据的提醒", async () => {
    const store = new MemoryRiskStore();
    store.workbooks = [{
      id: "workbook:claims",
      name: "债权台账",
      sheets: { materials: "ent_claims_materials" },
    }];
    store.recordsByTable.set("ent_claims_materials", [{
      id: "ent_claims_materials:delivery",
      material_name: "送货签收单",
      is_missing: true,
      review_notes: "缺少三月份签收单",
    }]);

    const result = await runDailyClaimsRiskCheck(store, {
      checkDate: "2026-07-17",
      checkedAt: new Date("2026-07-17T01:00:00.000Z"),
    });

    expect(result).toEqual({ status: "completed", remindersCreated: 1 });
    expect(store.saved[0]).toMatchObject({
      workbookId: "workbook:claims",
      recordId: "ent_claims_materials:delivery",
      riskType: "missing-material",
      title: "材料缺失：送货签收单",
      matchedFields: { is_missing: true, review_notes: "缺少三月份签收单" },
      rule: "证据材料记录的“是否缺失”为是",
    });
  });

  test("未来七天内的未完成待办生成期限提醒，已完成待办不提醒", async () => {
    const store = new MemoryRiskStore();
    store.workbooks = [{
      id: "workbook:claims",
      name: "债权台账",
      sheets: { tasks: "ent_claims_tasks" },
    }];
    store.recordsByTable.set("ent_claims_tasks", [
      {
        id: "ent_claims_tasks:collect",
        task_name: "补充工资流水",
        due_date: new Date("2026-07-20T00:00:00.000Z"),
        status: "待处理",
      },
      {
        id: "ent_claims_tasks:done",
        task_name: "归档审核结论",
        due_date: new Date("2026-07-18T00:00:00.000Z"),
        status: "已完成",
      },
      {
        id: "ent_claims_tasks:later",
        task_name: "远期复核",
        due_date: new Date("2026-08-01T00:00:00.000Z"),
        status: "待处理",
      },
    ]);

    const result = await runDailyClaimsRiskCheck(store, {
      checkDate: "2026-07-17",
      checkedAt: new Date("2026-07-17T01:00:00.000Z"),
    });

    expect(result.remindersCreated).toBe(1);
    expect(store.saved[0]).toMatchObject({
      recordId: "ent_claims_tasks:collect",
      riskType: "due-within-seven-days",
      matchedFields: { due_date: "2026-07-20T00:00:00.000Z", status: "待处理" },
      rule: "未完成待办的截止日期在检查日起七天内",
    });
  });

  test("审核金额超过申报金额或差异达到三成时生成金额异常提醒", async () => {
    const store = new MemoryRiskStore();
    store.workbooks = [{
      id: "workbook:claims",
      name: "债权台账",
      sheets: { creditors: "ent_claims_creditors" },
    }];
    store.recordsByTable.set("ent_claims_creditors", [
      {
        id: "ent_claims_creditors:over",
        creditor_name: "甲公司",
        declared_amount: 1_000_000,
        reviewed_amount: 1_100_000,
      },
      {
        id: "ent_claims_creditors:gap",
        creditor_name: "乙公司",
        declared_amount: 1_000_000,
        reviewed_amount: 700_000,
      },
      {
        id: "ent_claims_creditors:normal",
        creditor_name: "丙公司",
        declared_amount: 1_000_000,
        reviewed_amount: 900_000,
      },
    ]);

    const result = await runDailyClaimsRiskCheck(store, {
      checkDate: "2026-07-17",
      checkedAt: new Date("2026-07-17T01:00:00.000Z"),
    });

    expect(result.remindersCreated).toBe(2);
    expect(store.saved.map((item) => item.recordId)).toEqual([
      "ent_claims_creditors:over",
      "ent_claims_creditors:gap",
    ]);
    expect(store.saved[1]).toMatchObject({
      riskType: "amount-anomaly",
      matchedFields: { declared_amount: 1_000_000, reviewed_amount: 700_000, difference_ratio: 0.3 },
      rule: "审核金额超过申报金额，或两者差异达到申报金额的 30%",
    });
  });
});
