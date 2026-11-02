import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type {
  QuotaApiOperatorView,
  QuotaOpsPlanRevision,
} from "@surreal-ck/shared/native-quota";
import {
  QuotaOpsPreflightService,
  type QuotaOpsFreshReadPort,
} from "./quota-ops-preflight";
import type { QuotaOpsConsolePort } from "./quota-ops-console";

function view(
  capabilities: QuotaApiOperatorView["operator"]["capabilities"] = [
    "quota.read",
    "subscription.manage",
    "override.manage",
  ],
): QuotaApiOperatorView {
  return {
    format_version: 1,
    view: "operator",
    viewer: { subject: "operator", capabilities: ["quota.read"] },
    workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
    statuses: {
      sync: "in_sync",
      compliance: "compliant",
      capacity: "normal",
      service_mode: "standard",
      ledger: "ready",
    },
    observed_at: "2026-07-29T12:00:00.000Z",
    commercial_state_at: "2026-07-29T11:59:00.000Z",
    cache_age_ms: 0,
    usage_trusted: true,
    stale: false,
    applied: {
      source: "paid",
      plan_key: "pro",
      plan_name: "Pro",
      plan_revision: 2,
      entitlement_revision: 3,
      effective_at: "2026-07-01T00:00:00.000Z",
      effective_until: null,
      adjustment: null,
    },
    desired: null,
    billing_account: null,
    resources: [{
      key: "record/ent:ent_claim",
      resource: "record",
      label: "实体记录 · ent_claim",
      selector: {
        kind: "regex",
        description: "ent 开头的每张表",
        pattern: "^ent_",
        matched_tables: ["ent_claim"],
      },
      usage: {
        kind: "finite",
        limit: 100,
        used: 80,
        remaining: 20,
        over_by: 0,
        utilization_percent: 80,
        at_limit: false,
        over_limit: false,
      },
    }],
    actions: ["refresh"],
    operator: {
      capabilities,
      workspace_record: "workspace:demo",
      database: "ws_demo",
      billing_account_record: "billing_account:acme",
      billing_account_key: "acme",
      current_subscription: "quota_subscription:sub",
      desired_entitlement: null,
      applied_entitlement: "resource_entitlement:pro",
      desired_projection: null,
      applied_projection: "quota_policy_projection:pro",
      native_generation: 3,
      native_digest: "digest-pro",
      drift_error_code: null,
      auto_reconcile: true,
    },
  };
}

const plus: QuotaOpsPlanRevision = {
  id: "quota_plan_revision:plus_v1",
  plan_key: "plus",
  plan_name: "Plus",
  revision: 1,
  template_kind: "commercial",
  published_at: "2026-07-01T00:00:00.000Z",
  rules: [{
    rule_key: "record/ent",
    resource: "record",
    label: "实体记录",
    description: "ent 开头的每张表",
    selector: { kind: "regex", value: "^ent_" },
    limit: { kind: "finite", value: 50 },
  }],
};

function consolePort(): QuotaOpsConsolePort {
  return {
    async getContext() {
      throw new Error("not used");
    },
    async search() {
      throw new Error("not used");
    },
    async getTimeline() {
      throw new Error("not used");
    },
    async findPlanRevision({ id }) {
      return id.toString() === plus.id ? plus : null;
    },
  };
}

function service(
  value: QuotaApiOperatorView,
  plans: QuotaOpsConsolePort = consolePort(),
) {
  const reads: QuotaOpsFreshReadPort = {
    async getOperatorWorkspaceFresh() {
      return value;
    },
  };
  return new QuotaOpsPreflightService(reads, plans);
}

const BASELINE_FIELDS = [
  "format_version",
  "workspace",
  "kind",
  "required_capability",
  "observed_at",
  "usage_trusted",
  "stale",
  "effective_at",
  "current_plan",
  "target_plan",
  "affected_capabilities",
  "before_digest",
  "overage_count",
] as const;

type QuotaRow = QuotaApiOperatorView["resources"][number];

function finiteRow(
  resource: "record" | "table",
  key: string,
  selector: QuotaRow["selector"],
  limit: number,
  used: number | null,
): QuotaRow {
  return {
    key,
    resource,
    label: key,
    selector,
    usage: {
      kind: "finite",
      limit,
      used,
      remaining: null,
      over_by: null,
      utilization_percent: null,
      at_limit: null,
      over_limit: null,
    },
  };
}

const mixedPlan: QuotaOpsPlanRevision = {
  ...plus,
  id: "quota_plan_revision:mixed_v1",
  plan_key: "mixed",
  plan_name: "Mixed",
  rules: [
    {
      rule_key: "record/ent",
      resource: "record",
      label: "实体记录",
      description: "ent 开头的每张表",
      selector: { kind: "regex", value: "^ent_" },
      limit: { kind: "finite", value: 50 },
    },
    {
      rule_key: "table/orders",
      resource: "table",
      label: "订单表",
      description: "订单表不限",
      selector: { kind: "exact", value: "orders" },
      limit: { kind: "unlimited" },
    },
    {
      rule_key: "record/case",
      resource: "record",
      label: "案件记录",
      description: "尚无匹配资源的规则",
      selector: { kind: "regex", value: "^case_" },
      limit: { kind: "finite", value: 20 },
    },
  ],
};

const mixedResources: QuotaRow[] = [
  finiteRow(
    "record",
    "record/ent_a",
    { kind: "regex", description: "ent 开头的每张表", pattern: "^ent_", matched_tables: ["ent_a"] },
    100,
    80,
  ),
  finiteRow(
    "record",
    "record/ent_b",
    { kind: "regex", description: "ent 开头的每张表", pattern: "^ent_", matched_tables: ["ent_b"] },
    100,
    10,
  ),
  finiteRow(
    "record",
    "record/ent_c",
    { kind: "regex", description: "ent 开头的每张表", pattern: "^ent_", matched_tables: ["ent_c"] },
    100,
    null,
  ),
  {
    key: "table/orders",
    resource: "table",
    label: "业务表 · orders",
    selector: { kind: "exact", description: "固定表 orders", table: "orders" },
    usage: {
      kind: "unlimited",
      used: 500,
      utilization_percent: null,
      at_limit: false,
      over_limit: false,
    },
  },
  finiteRow(
    "table",
    "table/legacy",
    { kind: "exact", description: "固定表 legacy", table: "legacy" },
    10,
    3,
  ),
];

describe("QuotaOpsPreflightService", () => {
  test("uses fresh INFO and computes downgrade overage from authoritative plan revision", async () => {
    const result = await service(view()).preflight({
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "subscription_upsert",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      intentInput: {
        plan_revision: plus.id,
      },
    });
    expect(result).toMatchObject({
      required_capability: "subscription.manage",
      usage_trusted: true,
      stale: false,
      target_plan: {
        plan_key: "plus",
      },
      overage_count: 1,
      before_digest: "digest-pro",
      resources: [{
        current_limit: 100,
        target_limit: 50,
        used: 80,
        projected_over_by: 30,
      }],
    });
  });

  test("summary view keeps baseline fields and overage count equal to full view", async () => {
    const input = {
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "subscription_upsert" as const,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      intentInput: { plan_revision: plus.id },
    };
    const full = await service(view()).preflight(input);
    const summary = await service(view()).preflight({
      ...input,
      view: "summary",
    });
    if (!full || !summary) throw new Error("preflight returned null");
    for (const field of BASELINE_FIELDS) {
      expect(summary[field]).toEqual(full[field]);
    }
    expect(summary).toMatchObject({
      view: "summary",
      resources: [{
        resource: "record",
        rows: 1,
        over_count: 1,
        unknown_usage_rows: 0,
        unlimited_rows: 0,
        uncovered_rows: 0,
        used_total: 80,
        target_limit_total: 50,
        projected_over_by_total: 30,
      }],
    });
    expect(full).not.toHaveProperty("view");
  });

  test("summary of a wide workspace stays under the 48KiB employee budget", async () => {
    const template = view().resources[0];
    const wide: QuotaApiOperatorView = {
      ...view(),
      resources: Array.from({ length: 400 }, (_, index) => ({
        ...template,
        key: `record/ent_${index}`,
        label: `实体记录 · ent_${index}`,
        selector: {
          kind: "exact" as const,
          table: `ent_${index}`,
          description: `固定表 ent_${index}`,
        },
      })),
    };
    const input = {
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "override_schedule" as const,
      effectiveAt: "2026-07-29T12:00:00.000Z",
      intentInput: {},
    };
    const full = await service(wide).preflight(input);
    const summary = await service(wide).preflight({
      ...input,
      view: "summary",
    });
    if (!full || !summary || !("view" in summary)) {
      throw new Error("preflight returned unexpected view");
    }
    expect(full).not.toHaveProperty("view");
    expect(full.resources).toHaveLength(400);
    expect(full.resources[0]).toMatchObject({
      key: "record/ent_0",
      used: 80,
      projected_over_by: 0,
    });
    expect(
      new TextEncoder().encode(JSON.stringify(summary)).byteLength,
    ).toBeLessThan(48 * 1024);
    expect(summary.overage_count).toBe(full.overage_count);
    expect(
      summary.resources.reduce((total, row) => total + row.rows, 0),
    ).toBe(full.resources.length);
  });

  test("rejects mismatched workspace and missing fine-grained capability", async () => {
    const mismatch = await service(view()).preflight({
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:other"),
      kind: "override_schedule",
      effectiveAt: "2026-07-29T12:00:00.000Z",
      intentInput: {},
    });
    expect(mismatch).toBeNull();

    const missing = await service(view(["quota.read"])).preflight({
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "override_schedule",
      effectiveAt: "2026-07-29T12:00:00.000Z",
      intentInput: {},
    });
    expect(missing).toBeNull();
  });

  test("override preview never edits current/applied and reports non-worsening impact", async () => {
    const result = await service(view()).preflight({
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "override_schedule",
      effectiveAt: "2026-07-29T12:00:00.000Z",
      intentInput: {
        patches: [{
          rule_key: "record/ent",
          action: "replace",
          limit: { kind: "finite", value: 120 },
        }],
      },
    });
    expect(result?.resources[0]).toMatchObject({
      current_limit: 100,
      target_limit: 120,
      projected_over_by: 0,
    });
    expect(view().applied?.plan_key).toBe("pro");
  });

  test("subscription end must target the fresh current subscription", async () => {
    await expect(service(view()).preflight({
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "subscription_end",
      effectiveAt: "2026-07-30T00:00:00.000Z",
      intentInput: {
        subscription: "quota_subscription:stale",
        status: "canceled",
      },
    })).resolves.toBeNull();
  });

  test("a newly introduced selector reports unknown usage instead of optimistic zero", async () => {
    const contractPlan: QuotaOpsPlanRevision = {
      ...plus,
      id: "quota_plan_revision:contract_v1",
      plan_key: "contract",
      plan_name: "Contract",
      template_kind: "contract",
      rules: [{
        ...plus.rules[0]!,
        selector: { kind: "regex", value: "^case_" },
      }],
    };
    const plans: QuotaOpsConsolePort = {
      ...consolePort(),
      async findPlanRevision() {
        return contractPlan;
      },
    };
    const result = await service(view(), plans).preflight({
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "subscription_upsert",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      intentInput: { plan_revision: contractPlan.id },
    });
    expect(result?.resources[0]).toMatchObject({
      target_limit: 50,
      used: null,
      projected_over_by: null,
    });
  });

  test("summary separates unknown usage, unlimited and uncovered rows across resource types", async () => {
    const mixed: QuotaApiOperatorView = {
      ...view(),
      resources: mixedResources,
    };
    const plans: QuotaOpsConsolePort = {
      ...consolePort(),
      async findPlanRevision() {
        return mixedPlan;
      },
    };
    const input = {
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "subscription_upsert" as const,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      intentInput: { plan_revision: mixedPlan.id },
    };
    const full = await service(mixed, plans).preflight(input);
    const summary = await service(mixed, plans).preflight({
      ...input,
      view: "summary",
    });
    if (!full || !summary || !("view" in summary)) {
      throw new Error("preflight returned unexpected view");
    }
    for (const field of BASELINE_FIELDS) {
      expect(summary[field]).toEqual(full[field]);
    }
    expect(full).not.toHaveProperty("view");
    expect(full.overage_count).toBe(1);
    expect(full.resources).toMatchObject([
      {
        key: "record/ent_a",
        resource: "record",
        current_limit: 100,
        target_limit: 50,
        used: 80,
        projected_over_by: 30,
      },
      {
        key: "record/ent_b",
        resource: "record",
        current_limit: 100,
        target_limit: 50,
        used: 10,
        projected_over_by: 0,
      },
      {
        key: "record/ent_c",
        resource: "record",
        current_limit: 100,
        target_limit: 50,
        used: null,
        projected_over_by: null,
      },
      {
        key: "table/orders",
        resource: "table",
        current_limit: "unlimited",
        target_limit: "unlimited",
        used: 500,
        projected_over_by: null,
      },
      {
        key: "record/case",
        resource: "record",
        current_limit: null,
        target_limit: 20,
        used: null,
        projected_over_by: null,
      },
      {
        key: "table/legacy",
        resource: "table",
        current_limit: 10,
        target_limit: null,
        used: 3,
        projected_over_by: null,
      },
    ]);
    expect(summary.resources).toEqual([
      {
        resource: "record",
        rows: 4,
        over_count: 1,
        unknown_usage_rows: 2,
        unlimited_rows: 0,
        uncovered_rows: 0,
        used_total: 90,
        target_limit_total: 170,
        projected_over_by_total: 30,
      },
      {
        resource: "table",
        rows: 2,
        over_count: 0,
        unknown_usage_rows: 0,
        unlimited_rows: 1,
        uncovered_rows: 1,
        used_total: 503,
        target_limit_total: 0,
        projected_over_by_total: 0,
      },
    ]);
    expect(summary.overage_count).toBe(full.overage_count);
  });

  test("summary view rejects mismatched workspace and missing fine-grained capability", async () => {
    const input = {
      actor: { subject: "operator" },
      workspaceSlug: "demo",
      workspace: new StringRecordId("workspace:demo"),
      kind: "override_schedule" as const,
      effectiveAt: "2026-07-29T12:00:00.000Z",
      intentInput: {},
      view: "summary" as const,
    };
    await expect(service(view()).preflight({
      ...input,
      workspace: new StringRecordId("workspace:other"),
    })).resolves.toBeNull();
    await expect(service(view(["quota.read"])).preflight(input))
      .resolves.toBeNull();
  });
});
