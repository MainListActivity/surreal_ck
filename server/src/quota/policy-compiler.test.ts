import { describe, expect, test } from "bun:test";
import { DateTime, StringRecordId } from "surrealdb";
import {
  NativeQuotaRuleSchema,
  type ProductQuotaRule,
  type ResourceEntitlementRecord,
} from "@surreal-ck/shared/native-quota";
import {
  PolicyCompileError,
  compileQuotaPolicy,
} from "./policy-compiler";

function id(value: string): StringRecordId {
  return new StringRecordId(value);
}

function date(value = "2026-08-01T00:00:00.000Z"): DateTime {
  return new DateTime(value);
}

function finite(value: number | bigint) {
  return { kind: "finite" as const, value };
}

function planRules(): ProductQuotaRule[] {
  return [
    {
      rule_key: "fallback-table",
      resource: "table",
      selector: { kind: "regex", value: ".*" },
      limit: { kind: "unlimited" },
      customer_label: "其他数据表",
    },
    {
      rule_key: "entity-tables",
      resource: "table",
      selector: { kind: "regex", value: "^ent_" },
      limit: finite(10),
      customer_label: "实体数据表数",
    },
    {
      rule_key: "fallback-field",
      resource: "field",
      selector: { kind: "regex", value: ".*" },
      limit: { kind: "unlimited" },
      customer_label: "其他表字段",
    },
    {
      rule_key: "entity-fields",
      resource: "field",
      selector: { kind: "regex", value: "^ent_" },
      limit: finite(20),
      customer_label: "每张实体表字段数",
    },
    {
      rule_key: "system-sheet-fields",
      resource: "field",
      selector: { kind: "exact", value: "sheet" },
      limit: { kind: "unlimited" },
      customer_label: "系统数据表字段",
    },
    {
      rule_key: "fallback-record",
      resource: "record",
      selector: { kind: "regex", value: ".*" },
      limit: { kind: "unlimited" },
      customer_label: "其他表记录",
    },
    {
      rule_key: "entity-records",
      resource: "record",
      selector: { kind: "regex", value: "^ent_" },
      limit: finite(1_000),
      customer_label: "每张实体表记录数",
      customer_description: "每个 ent_ 数据表分别计数",
    },
    {
      rule_key: "system-sheet-records",
      resource: "record",
      selector: { kind: "exact", value: "sheet" },
      limit: { kind: "unlimited" },
      customer_label: "系统数据表记录",
    },
  ];
}

function entitlement(
  rules: readonly unknown[] = planRules(),
  overrides: Partial<ResourceEntitlementRecord> = {},
): ResourceEntitlementRecord {
  return {
    id: id("resource_entitlement:acme_v1"),
    workspace: id("workspace:acme"),
    revision: 1,
    source_type: "paid",
    subscription_item: id("quota_subscription_item:acme"),
    plan_revision: id("quota_plan_revision:plus_v1"),
    service_mode: "standard",
    rules: rules as readonly ProductQuotaRule[],
    source_digest: "sha256:source",
    effective_at: date(),
    resolved_at: date(),
    correlation_id: "corr-entitlement",
    ...overrides,
  };
}

function compile(rules: readonly unknown[] = planRules()) {
  return compileQuotaPolicy({
    projection: {
      id: id("quota_policy_projection:acme_v1"),
      revision: 1,
      createdAt: date(),
    },
    entitlement: entitlement(rules),
  });
}

describe("compileQuotaPolicy", () => {
  test("input order does not change canonical native rules, labels, or digest", () => {
    const ordered = compile(planRules());
    const reversed = compile(planRules().reverse());

    expect(reversed.rules).toEqual(ordered.rules);
    expect(reversed.ruleLabels).toEqual(ordered.ruleLabels);
    expect(reversed.projection.canonical_digest).toBe(
      ordered.projection.canonical_digest,
    );
  });

  test("emits exact/regex, overlapping regex, and unlimited rules matching the native DTO", () => {
    const overlapping = [
      ...planRules(),
      {
        rule_key: "special-entity-records",
        resource: "record",
        selector: { kind: "regex", value: "^ent_special_" },
        limit: finite(50),
        customer_label: "特殊实体记录数",
      },
    ];

    const compiled = compile(overlapping);

    expect(NativeQuotaRuleSchema.array().parse(compiled.rules)).toEqual(
      compiled.rules,
    );
    expect(compiled.rules).toContainEqual(expect.objectContaining({
      resource: "record",
      selector: { kind: "regex", pattern: "^ent_" },
      limit: finite(1_000),
    }));
    expect(compiled.rules).toContainEqual(expect.objectContaining({
      resource: "record",
      selector: { kind: "regex", pattern: "^ent_special_" },
      limit: finite(50),
    }));
    expect(compiled.rules).toContainEqual(expect.objectContaining({
      resource: "field",
      selector: { kind: "exact", table: "sheet" },
      limit: { kind: "unlimited" },
    }));
    expect(compiled.rules).toContainEqual(expect.objectContaining({
      resource: "table",
      selector: { kind: "regex", pattern: ".*" },
      limit: { kind: "unlimited" },
    }));
  });

  test("rule id is stable across limit changes and pinned by resource + semantic rule key", () => {
    const initial = compile();
    const changedRules = planRules().map((rule) =>
      rule.rule_key === "entity-records"
        ? { ...rule, limit: finite(2_000) }
        : rule
    );
    const changed = compile(changedRules);
    const initialRule = initial.ruleLabels.find(
      (label) => label.rule_key === "entity-records",
    );
    const changedRule = changed.ruleLabels.find(
      (label) => label.rule_key === "entity-records",
    );

    expect(initialRule?.rule_id).toBe("q_record_100e44b23b46d026045a");
    expect(changedRule?.rule_id).toBe(initialRule?.rule_id);
    expect(changed.projection.canonical_digest).not.toBe(
      initial.projection.canonical_digest,
    );

    const selectorChanged = compile(planRules().map((rule) =>
      rule.rule_key === "system-sheet-fields"
        ? { ...rule, selector: { kind: "exact" as const, value: "workbook" } }
        : rule
    ));
    expect(selectorChanged.ruleLabels.find(
      (label) => label.rule_key === "system-sheet-fields",
    )?.rule_id).toBe(initial.ruleLabels.find(
      (label) => label.rule_key === "system-sheet-fields",
    )?.rule_id);
  });

  test("commercial source change with identical rules keeps the native digest for no-DDL sync", () => {
    const first = compile();
    const payerChanged = compileQuotaPolicy({
      projection: {
        id: id("quota_policy_projection:acme_v2"),
        revision: 2,
        createdAt: date("2026-08-02T00:00:00.000Z"),
      },
      entitlement: entitlement(planRules(), {
        id: id("resource_entitlement:acme_v2"),
        subscription_item: id("quota_subscription_item:new_payer"),
        source_digest: "sha256:new-source",
      }),
    });

    expect(payerChanged.projection.entitlement.toString()).toBe(
      "resource_entitlement:acme_v2",
    );
    expect(payerChanged.projection.canonical_digest).toBe(
      first.projection.canonical_digest,
    );
  });

  test("keeps a customer-facing label mapping without putting labels in the native digest", () => {
    const initial = compile();
    const renamed = compile(planRules().map((rule) =>
      rule.rule_key === "entity-records"
        ? { ...rule, customer_label: "新的展示名称" }
        : rule
    ));

    expect(initial.ruleLabels.find(
      (label) => label.rule_key === "entity-records",
    )).toMatchObject({
      customer_label: "每张实体表记录数",
      customer_description: "每个 ent_ 数据表分别计数",
    });
    expect(renamed.projection.canonical_digest).toBe(
      initial.projection.canonical_digest,
    );
  });

  test("rejects missing fallback, missing ^ent_ coverage, invalid regex, duplicate exact and invalid limits", () => {
    const cases: Array<{
      name: string;
      rules: readonly unknown[];
      code: PolicyCompileError["code"];
    }> = [
      {
        name: "missing fallback",
        rules: planRules().filter((rule) => rule.rule_key !== "fallback-field"),
        code: "missing_fallback",
      },
      {
        name: "missing entity coverage",
        rules: planRules().filter((rule) => rule.rule_key !== "entity-tables"),
        code: "missing_managed_rule",
      },
      {
        name: "invalid regex",
        rules: planRules().map((rule) =>
          rule.rule_key === "entity-records"
            ? { ...rule, selector: { kind: "regex", value: "[" } }
            : rule
        ),
        code: "invalid_regex",
      },
      {
        name: "duplicate exact",
        rules: [
          ...planRules(),
          {
            rule_key: "duplicate-sheet-fields",
            resource: "field",
            selector: { kind: "exact", value: "sheet" },
            limit: finite(10),
            customer_label: "重复",
          },
        ],
        code: "duplicate_selector",
      },
      {
        name: "negative limit",
        rules: planRules().map((rule) =>
          rule.rule_key === "entity-records"
            ? { ...rule, limit: finite(-1) }
            : rule
        ),
        code: "limit_out_of_range",
      },
      {
        name: "SurrealDB int overflow",
        rules: planRules().map((rule) =>
          rule.rule_key === "entity-records"
            ? { ...rule, limit: finite(9_223_372_036_854_775_808n) }
            : rule
        ),
        code: "limit_out_of_range",
      },
      {
        name: "unknown resource",
        rules: planRules().map((rule) =>
          rule.rule_key === "entity-records"
            ? { ...rule, resource: "storage" }
            : rule
        ),
        code: "unknown_resource",
      },
      {
        name: "duplicate semantic rule key",
        rules: [
          ...planRules(),
          {
            rule_key: "entity-records",
            resource: "field",
            selector: { kind: "exact", value: "ent_special" },
            limit: finite(10),
            customer_label: "重复 key",
          },
        ],
        code: "duplicate_rule_key",
      },
    ];

    for (const row of cases) {
      expect(
        () => compile(row.rules),
        row.name,
      ).toThrow(
        expect.objectContaining<Partial<PolicyCompileError>>({
          code: row.code,
        }),
      );
    }
  });

  test("retention projection requires finite zero-growth ^ent_ rules", () => {
    const zeroGrowth = planRules().map((rule) =>
      rule.selector.kind === "regex" && rule.selector.value === "^ent_"
        ? { ...rule, limit: finite(0) }
        : rule
    );
    expect(() => compileQuotaPolicy({
      projection: {
        id: id("quota_policy_projection:retention_v1"),
        revision: 1,
        createdAt: date(),
      },
      entitlement: entitlement(zeroGrowth, {
        source_type: "retention",
        service_mode: "retention",
        subscription_item: undefined,
      }),
    })).not.toThrow();

    expect(() => compileQuotaPolicy({
      projection: {
        id: id("quota_policy_projection:retention_invalid"),
        revision: 2,
        createdAt: date(),
      },
      entitlement: entitlement(planRules(), {
        source_type: "retention",
        service_mode: "retention",
        subscription_item: undefined,
      }),
    })).toThrow(
      expect.objectContaining<Partial<PolicyCompileError>>({
        code: "invalid_retention_policy",
      }),
    );
  });
});
