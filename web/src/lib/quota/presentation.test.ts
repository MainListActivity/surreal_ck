import { describe, expect, test } from "bun:test";
import {
  availableQuotaOpsActions,
  capacityPresentation,
  overrideRuleOptions,
  formatQuotaCount,
  isIntentTerminal,
  quotaApiErrorMessage,
  quotaExceededMessage,
} from "./presentation";
import { QuotaApiError } from "./client";

describe("quota UI presentation", () => {
  test("at_limit and over_limit stay distinct", () => {
    expect(capacityPresentation("at_limit").label).toBe("已用满");
    expect(capacityPresentation("over_limit").label).toBe("已超额");
    expect(capacityPresentation("unknown").description).toContain("不能将未知视为 0");
  });

  test("operator actions compose by fine-grained capabilities", () => {
    const actions = availableQuotaOpsActions([
      "quota.read",
      "override.manage",
      "reconcile.audit",
    ]);
    expect(actions.some((action) => action.kind === "override_schedule")).toBe(true);
    expect(actions.some((action) => action.kind === "audit_now")).toBe(true);
    expect(actions.some((action) => action.kind === "subscription_upsert")).toBe(false);
    expect(actions.some((action) => action.kind === "ledger_rebuild")).toBe(false);
  });

  test("unknown counts and rate limit have explicit language", () => {
    expect(formatQuotaCount(null)).toBe("暂不可确认");
    expect(quotaApiErrorMessage(
      new QuotaApiError(429, "quota-refresh-rate-limited", "rate"),
    )).toContain("10 秒");
  });

  test("only processed and terminal_failed stop operation tracking", () => {
    expect(isIntentTerminal("processed")).toBe(true);
    expect(isIntentTerminal("terminal_failed")).toBe(true);
    expect(isIntentTerminal("failed")).toBe(false);
    expect(isIntentTerminal("processing")).toBe(false);
  });

  test("regex-expanded resources map back to one semantic override rule", () => {
    expect(overrideRuleOptions([
      {
        key: "record/ent:ent_claim",
        resource: "record",
        label: "实体记录",
        selector: {
          kind: "regex",
          description: "ent 开头的表",
          pattern: "^ent_",
          matched_tables: ["ent_claim", "ent_party"],
        },
        usage: {
          kind: "finite",
          limit: 100,
          used: 10,
          remaining: 90,
          over_by: 0,
          utilization_percent: 10,
          at_limit: false,
          over_limit: false,
        },
      },
      {
        key: "record/ent:ent_party",
        resource: "record",
        label: "实体记录",
        selector: {
          kind: "regex",
          description: "ent 开头的表",
          pattern: "^ent_",
          matched_tables: ["ent_claim", "ent_party"],
        },
        usage: {
          kind: "finite",
          limit: 100,
          used: 20,
          remaining: 80,
          over_by: 0,
          utilization_percent: 20,
          at_limit: false,
          over_limit: false,
        },
      },
    ])).toEqual([{
      key: "record/ent",
      label: "实体记录 · 正则 ^ent_",
    }]);
  });
});

describe("quotaExceededMessage", () => {
  test("管理员视图显示资源类型、当前用量与上限，且不提升级计划", () => {
    const text = quotaExceededMessage([
      { resource: "record", limit: 6, current: 6 },
      { resource: "table", limit: 1, current: 1 },
    ]);
    expect(text).toContain("记录数量：当前 6，上限 6");
    expect(text).toContain("数据表数量：当前 1，上限 1");
    expect(text).toContain("邀请人");
    expect(text).not.toContain("升级");
  });

  test("参与者视图只有资源类型，不泄露用量数字", () => {
    const text = quotaExceededMessage([{ resource: "field" }]);
    expect(text).toContain("字段数量已达到上限");
    expect(text).not.toMatch(/当前 \d|上限 \d/);
    expect(text).not.toContain("升级");
  });

  test("无违规项时仍给出可操作的引导", () => {
    const text = quotaExceededMessage([]);
    expect(text).toContain("邀请人");
    expect(text).not.toContain("升级");
  });
});
