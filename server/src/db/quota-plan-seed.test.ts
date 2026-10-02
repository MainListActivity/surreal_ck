import { describe, expect, test } from "bun:test";
import { seedQuotaPlans, type QuotaPlanSeedClient } from "./quota-plan-seed";
import { MAX_V2_LIMITS, SEEDED_PLAN_LIMITS } from "./quota-plan-rules";
import type { ProductQuotaRule } from "@surreal-ck/shared/native-quota";

type Captured = { sql: string; params?: Record<string, unknown> };

function fakeClient(): { client: QuotaPlanSeedClient; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    client: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return [];
      },
    },
  };
}

function entityRuleValue(rules: ProductQuotaRule[], resource: string): number {
  const rule = rules.find((candidate) =>
    candidate.resource === resource
    && candidate.selector.kind === "regex"
    && candidate.selector.value === "^ent_"
  );
  if (!rule || rule.limit.kind !== "finite") throw new Error(`missing finite ${resource} rule`);
  return Number(rule.limit.value);
}

describe("seedQuotaPlans", () => {
  test("CV02：补齐不可变的 max_v2 修订并把 max.active_revision 指向它", async () => {
    const { client, calls } = fakeClient();
    await seedQuotaPlans({ getDbSession: async () => client, namespace: "main" });

    const v2 = calls.find((call) => call.params?.revisionKey === "max_v2");
    expect(v2).toBeDefined();
    expect(v2!.sql).toContain('type::record("quota_plan_revision", $revisionKey)');
    // 不可变：仅不存在才 CREATE（IF 守卫），随后收敛 active_revision。
    expect(v2!.sql).toContain("IF array::len($existing) = 0");
    expect(v2!.sql).toContain("revision: 2");
    expect(v2!.sql).toContain('active_revision = type::record("quota_plan_revision", $revisionKey)');
    const rules = v2!.params!.rules as ProductQuotaRule[];
    expect(entityRuleValue(rules, "table")).toBe(MAX_V2_LIMITS.tables);
    expect(entityRuleValue(rules, "field")).toBe(MAX_V2_LIMITS.fields);
    expect(entityRuleValue(rules, "record")).toBe(MAX_V2_LIMITS.records);
    expect(entityRuleValue(rules, "table")).toBe(3);
    expect(entityRuleValue(rules, "field")).toBe(11);
    expect(entityRuleValue(rules, "record")).toBe(12);
  });

  test("v1 修订照常 seed 且数值不变（既有订阅/审计对照不动）", async () => {
    const { client, calls } = fakeClient();
    await seedQuotaPlans({ getDbSession: async () => client, namespace: "main" });

    for (const [key, limits] of Object.entries(SEEDED_PLAN_LIMITS)) {
      const call = calls.find((entry) => entry.params?.revisionKey === `${key}_v1`);
      expect(call).toBeDefined();
      const rules = call!.params!.rules as ProductQuotaRule[];
      expect(entityRuleValue(rules, "table")).toBe(limits.tables);
      expect(entityRuleValue(rules, "field")).toBe(limits.fields);
      expect(entityRuleValue(rules, "record")).toBe(limits.records);
    }
  });

  test("幂等：两次执行只发 INSERT-if-missing + UPDATE，不产生重复修订", async () => {
    const { client, calls } = fakeClient();
    await seedQuotaPlans({ getDbSession: async () => client, namespace: "main" });
    await seedQuotaPlans({ getDbSession: async () => client, namespace: "main" });
    // 两次调用发的语句集合一致；幂等性在 SQL 内由 IF 守卫 + ON DUPLICATE KEY 保证。
    const v2Calls = calls.filter((call) => call.params?.revisionKey === "max_v2");
    expect(v2Calls).toHaveLength(2);
    for (const call of v2Calls) {
      expect(call.sql).toContain("IF array::len($existing) = 0");
    }
  });
});
