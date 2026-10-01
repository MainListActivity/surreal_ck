import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import { createApiClient } from "./api";
import {
  buildRiskReminderAiContext,
  loadRiskNotifications,
  resolveOfficeRequest,
  resolveRiskNotificationTarget,
  loadClaimsReminderSettings,
  setClaimsReminderEnabled,
  wakeOfficeRequest,
  type RiskNotification,
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
    const notification: RiskNotification = {
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
      purpose: "claims-risk",
      fromEmployee: "",
      taskId: "",
      questionType: "free-text",
      options: [],
      resolvedAt: "",
      resolution: "",
      answerAction: null,
      answerText: "",
    };
    const context = buildRiskReminderAiContext(notification);

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

describe("VO03 人类请求收件箱", () => {
  test("office-request 行映射出问题类型、选项、发起员工与终态字段", async () => {
    const conn = {
      async query() {
        return [{
          id: "user_notification:ofreq_t1_ab12cd34ef",
          purpose: "office-request",
          title: "员工请你选择",
          body: "采用哪种口径合并重复债权？",
          severity: "info",
          created_at: "2026-07-20T02:00:00.000Z",
          from_employee: "user:pm_9f",
          task: "office_task:pm_initial",
          payload: { question_type: "choice", options: ["按金额", "按日期"], run_id: "er-x" },
        }];
      },
    } as unknown as SurrealConn;

    const [notification] = await loadRiskNotifications(conn);

    expect(notification).toMatchObject({
      id: "user_notification:ofreq_t1_ab12cd34ef",
      purpose: "office-request",
      fromEmployee: "user:pm_9f",
      taskId: "office_task:pm_initial",
      questionType: "choice",
      options: ["按金额", "按日期"],
      resolvedAt: "",
      answerAction: null,
    });
  });

  test("已终态的请求读回答案与解决时间，缺省 purpose 的老行仍按债权提醒呈现", async () => {
    const conn = {
      async query() {
        return [
          {
            id: "user_notification:ofreq_t1_x",
            purpose: "office-request",
            title: "员工向你提问",
            body: "三月签收单是否已补齐？",
            resolved_at: "2026-07-20T03:00:00.000Z",
            resolution: "已补齐并上传",
            answer: { action: "answered", text: "已补齐并上传" },
          },
          {
            id: "user_notification:n9",
            title: "材料缺失：发票",
            severity: "warning",
            risk_type: "missing-material",
          },
        ];
      },
    } as unknown as SurrealConn;

    const [request, risk] = await loadRiskNotifications(conn);

    expect(request.purpose).toBe("office-request");
    expect(request.answerAction).toBe("answered");
    expect(request.answerText).toBe("已补齐并上传");
    expect(request.resolvedAt).toBe("2026-07-20T03:00:00.000Z");
    expect(risk.purpose).toBe("claims-risk");
    expect(risk.riskType).toBe("missing-material");
  });

  test("答复先以 CAS 落库再返回 resolved，重复提交读回 already-resolved", async () => {
    const calls: { sql: string; bindings?: Record<string, unknown> }[] = [];
    let resolved = false;
    const conn = {
      async query(sql: string, bindings?: Record<string, unknown>) {
        calls.push({ sql, bindings });
        if (sql.includes("UPDATE")) {
          if (resolved) return [];
          resolved = true;
          return [{ id: "user_notification:ofreq_t1_x" }];
        }
        return [{
          resolved_at: resolved ? "2026-07-20T03:00:00.000Z" : null,
          answer: resolved ? { action: "answered", text: "已补齐" } : null,
          resolution: resolved ? "已补齐" : null,
        }];
      },
    } as unknown as SurrealConn;

    const first = await resolveOfficeRequest(conn, "user_notification:ofreq_t1_x", {
      action: "answered",
      text: "已补齐",
    });
    expect(first.status).toBe("resolved");
    expect(calls[0].sql).toContain("WHERE resolved_at = NONE");
    expect(calls[0].bindings?.answer).toMatchObject({ action: "answered", text: "已补齐" });

    const second = await resolveOfficeRequest(conn, "user_notification:ofreq_t1_x", {
      action: "rejected",
      text: "改口拒绝",
    });
    expect(second).toMatchObject({ status: "already-resolved", answerAction: "answered" });
  });

  test("通知不可见时如实返回 not-visible，不伪装成功", async () => {
    const conn = {
      async query() { return []; },
    } as unknown as SurrealConn;
    const outcome = await resolveOfficeRequest(conn, "user_notification:ghost", {
      action: "answered",
      text: "x",
    });
    expect(outcome.status).toBe("not-visible");
  });

  test("唤醒调用打向 wake 端点并编码记录 id；非 2xx 抛出带状态的错误", async () => {
    const posts: { param: { slug: string; notificationId: string } }[] = [];
    const client = {
      api: {
        workspaces: {
          ":slug": {
            office: {
              requests: {
                ":notificationId": {
                  wake: {
                    async $post(input: { param: { slug: string; notificationId: string } }) {
                      posts.push(input);
                      return new Response(JSON.stringify({ outcome: "completed" }), { status: 200 });
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = await wakeOfficeRequest("acme", "user_notification:ofreq_t1_x", client);
    expect(result.outcome).toBe("completed");
    expect(posts[0].param.notificationId).toBe("user_notification%3Aofreq_t1_x");

    const failing = {
      api: {
        workspaces: {
          ":slug": {
            office: {
              requests: {
                ":notificationId": {
                  wake: {
                    async $post() {
                      return new Response("boom", { status: 409 });
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    await expect(wakeOfficeRequest("acme", "user_notification:ofreq_t1_x", failing))
      .rejects.toThrow("唤醒失败（409）");
  });

  test("真实 hc 客户端构造的唤醒 URL 必须带 /api 前缀（回归：QA 实测恒 405）", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub: typeof fetch = async (input, init = {}) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init });
      return new Response(JSON.stringify({ outcome: "completed" }), { status: 200 });
    };
    const client = createApiClient({ baseUrl: "https://api.test", getToken: () => null, fetch: fetchStub }).api;

    const result = await wakeOfficeRequest("acme", "user_notification:ofreq_t1_x", client);
    expect(result.outcome).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://api.test/api/workspaces/acme/office/requests/user_notification%3Aofreq_t1_x/wake",
    );
  });
});
