import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import {
  buildRiskReminderAiContext,
  loadRiskNotifications,
  resolveRiskNotificationTarget,
  loadClaimsReminderSettings,
  setClaimsReminderEnabled,
} from "./risk-notifications";

describe("OIP-18 风险提醒收件箱", () => {
  test("读取提醒时保留命中字段、规则、检查时间和记录跳转目标", async () => {
    const conn = {
      async query() {
        return [{
          id: "user_notification:n1",
          workbook: "workbook:claims",
          workbook_name: "债权台账",
          related_record: "ent_claims_materials:m1",
          risk_type: "missing-material",
          title: "材料缺失：送货签收单",
          body: "缺少三月份签收单",
          severity: "warning",
          matched_fields: { is_missing: true, review_notes: "缺少三月份签收单" },
          rule: "证据材料记录的“是否缺失”为是",
          checked_at: "2026-07-17T01:00:00.000Z",
          created_at: "2026-07-17T01:00:01.000Z",
        }];
      },
    } as unknown as SurrealConn;

    const [notification] = await loadRiskNotifications(conn);

    expect(notification).toMatchObject({
      id: "user_notification:n1",
      workbookId: "workbook:claims",
      recordId: "ent_claims_materials:m1",
      matchedFields: { is_missing: true, review_notes: "缺少三月份签收单" },
      rule: "证据材料记录的“是否缺失”为是",
      checkedAt: "2026-07-17T01:00:00.000Z",
    });
  });

  test("继续询问 AI 的上下文只包含已读取的命中事实和规则", () => {
    const context = buildRiskReminderAiContext({
      id: "user_notification:n1",
      workbookId: "workbook:claims",
      workbookName: "债权台账",
      recordId: "ent_claims_materials:m1",
      riskType: "missing-material",
      title: "材料缺失：送货签收单",
      body: "缺少三月份签收单",
      severity: "warning",
      matchedFields: { is_missing: true },
      rule: "证据材料记录的“是否缺失”为是",
      checkedAt: "2026-07-17T01:00:00.000Z",
      createdAt: "2026-07-17T01:00:01.000Z",
    });

    expect(context.selectedRow?.visibleValues).toEqual({
      is_missing: true,
      rule: "证据材料记录的“是否缺失”为是",
      checked_at: "2026-07-17T01:00:00.000Z",
    });
    expect(context.selectedRow?.visibleValues).not.toHaveProperty("model_guess");
  });

  test("按关联记录的真实表名解析工作簿内数据表跳转目标", async () => {
    const conn = {
      async query() { return [{ id: "sheet:materials" }]; },
    } as unknown as SurrealConn;

    expect(await resolveRiskNotificationTarget(conn, {
      workbookId: "workbook:claims",
      recordId: "ent_claims_materials:m1",
    })).toEqual({
      workbookId: "workbook:claims",
      sheetId: "sheet:materials",
      recordId: "ent_claims_materials:m1",
    });
  });

  test("用户可以为已安装的破产债权工作簿启停每日提醒", async () => {
    const patches: unknown[] = [];
    const conn = {
      async query() {
        return [{ id: "workbook:claims", name: "债权台账", risk_reminders_enabled: false }];
      },
      async updateRecord(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
        return {};
      },
    } as unknown as SurrealConn;

    expect(await loadClaimsReminderSettings(conn)).toEqual([
      { workbookId: "workbook:claims", workbookName: "债权台账", enabled: false },
    ]);
    await setClaimsReminderEnabled(conn, "workbook:claims", true);
    expect(patches).toEqual([{
      id: "workbook:claims",
      patch: { risk_reminders_enabled: true },
    }]);
  });
});
