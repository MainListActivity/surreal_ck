import { describe, expect, test } from "bun:test";
import { createOpsInvitationSchema } from "./ops-invitation";

const base = {
  email: "lawyer@example.com",
  displayName: "陈律师",
  workspaceSlug: "acme-bankruptcy",
  aiAllowance: { amount: 500, expiresAt: "2099-01-01T00:00:00Z" },
  reason: "G2 试点邀请",
  idempotencyKey: "schema-test-key-001",
};

describe("createOpsInvitationSchema", () => {
  test("缺省 planKey 为 pro", () => {
    expect(createOpsInvitationSchema.parse(base).planKey).toBe("pro");
  });

  test("显式 planKey 与 quotaPlanRevisionId 原样保留", () => {
    const parsed = createOpsInvitationSchema.parse({
      ...base,
      planKey: "trial",
      quotaPlanRevisionId: "quota_plan_revision:trial_v2",
    });
    expect(parsed.planKey).toBe("trial");
    expect(parsed.quotaPlanRevisionId).toBe("quota_plan_revision:trial_v2");
  });

  test("quotaPlanRevisionId 必须是 quota_plan_revision: 前缀的记录 id", () => {
    expect(() =>
      createOpsInvitationSchema.parse({ ...base, quotaPlanRevisionId: "trial_v2" }),
    ).toThrow();
    expect(() =>
      createOpsInvitationSchema.parse({ ...base, quotaPlanRevisionId: "product_plan_revision:trial_v2" }),
    ).toThrow();
  });

  test("非法 planKey（大写或非法字符）被拒绝，不静默回退", () => {
    expect(() => createOpsInvitationSchema.parse({ ...base, planKey: "Trial" })).toThrow();
    expect(() => createOpsInvitationSchema.parse({ ...base, planKey: "trial v2" })).toThrow();
  });
});
