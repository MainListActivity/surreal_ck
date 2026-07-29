import { describe, expect, test } from "bun:test";
import {
  availableQuotaOpsActions,
  capacityPresentation,
  overrideRuleOptions,
  formatQuotaCount,
  isIntentTerminal,
  quotaApiErrorMessage,
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
