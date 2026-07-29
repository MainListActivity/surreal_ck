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
});
