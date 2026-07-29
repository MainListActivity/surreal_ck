import { describe, expect, test } from "bun:test";
import { SurrealQuotaAuthorityReader } from "./quota-authority-reader";

function entitlement(id: string, plan: string) {
  return {
    id,
    revision: 1,
    source_type: "paid",
    service_mode: "standard",
    effective_at: "2026-07-01T00:00:00.000Z",
    effective_until: null,
    plan_revision: {
      id: `quota_plan_revision:${plan}-1`,
      revision: 1,
      plan: {
        id: `quota_plan:${plan}`,
        plan_key: plan,
        display_name: plan.toUpperCase(),
      },
    },
  };
}

function projection(id: string) {
  return {
    id,
    canonical_digest: `${id}-digest`,
    rules: [{
      rule_id: "record-ent",
      resource: "record",
      selector: { kind: "regex", pattern: "^ent_" },
      limit: { kind: "finite", value: 100 },
    }],
    rule_labels: [{
      rule_id: "record-ent",
      rule_key: "record/ent",
      resource: "record",
      customer_label: "实体记录",
      customer_description: "ent 表",
    }],
  };
}

describe("SurrealQuotaAuthorityReader", () => {
  test("resolves independent workspace, billing and operator capabilities", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const reader = new SurrealQuotaAuthorityReader({
      db: {
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FROM ONLY workspace\n")) {
            return [[{
              id: "workspace:demo",
              slug: "demo",
              name: "Demo",
              db_name: "ws_demo",
              status: "active",
              updated_at: "2026-07-28T00:00:00.000Z",
              desired_entitlement: entitlement("resource_entitlement:desired", "pro"),
              applied_entitlement: entitlement("resource_entitlement:applied", "plus"),
              desired_quota_projection: projection("quota_policy_projection:desired"),
              applied_quota_projection: projection("quota_policy_projection:applied"),
            }]];
          }
          if (sql.includes("FROM user_workspace_index")) return [["admin"]];
          if (sql.includes("FROM platform_operator_capability")) {
            return [["quota.read", "override.manage"]];
          }
          if (sql.includes("FROM ONLY workspace_quota_runtime")) {
            return [[{
              sync_state: "pending",
              quota_compliance: "compliant",
              capacity_state: "warning",
              service_mode: "standard",
              ledger_state: "ready",
              usage_trusted: true,
              auto_reconcile: true,
              native_observed_generation: 3,
              native_observed_digest: "digest",
              updated_at: "2026-07-28T00:01:00.000Z",
            }]];
          }
          if (sql.includes("FROM quota_subscription_item")) {
            return [[{
              subscription: {
                id: "quota_subscription:sub",
                source: "provider",
                status: "active",
                current_period_end: "2026-08-01T00:00:00.000Z",
                cancel_at_period_end: false,
                billing_account: {
                  id: "billing_account:team",
                  account_key: "team",
                  name: "Team",
                },
              },
            }]];
          }
          if (sql.includes("FROM billing_account_member")) return [["owner"]];
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await reader.findWorkspaceAuthority({
      slug: "demo",
      actor: { subject: "alice", email: "Alice@example.com" },
    });

    expect(result).toMatchObject({
      workspace: {
        record: "workspace:demo",
        slug: "demo",
        database: "ws_demo",
      },
      workspaceRole: "admin",
      billingRole: "owner",
      operatorCapabilities: ["quota.read", "override.manage"],
      appliedEntitlement: { planKey: "plus" },
      desiredEntitlement: { planKey: "pro" },
      subscription: {
        id: "quota_subscription:sub",
        source: "provider",
        current_period_end: "2026-08-01T00:00:00.000Z",
        billingAccountRecord: "billing_account:team",
        billingAccountKey: "team",
      },
      runtime: {
        sync: "pending",
        capacity: "warning",
        nativeGeneration: 3,
      },
      commercialStateAt: "2026-07-28T00:01:00.000Z",
    });
    expect(result?.appliedProjection?.rules[0]).toMatchObject({
      rule_id: "record-ent",
      rule_key: "record/ent",
      selector: { kind: "regex", pattern: "^ent_" },
    });

    const workspaceMembership = calls.find((call) =>
      call.sql.includes("FROM user_workspace_index")
    );
    expect(workspaceMembership?.sql).toContain("workspace = $workspace");
    expect(workspaceMembership?.sql).toContain("subject = $subject");
    expect(workspaceMembership?.params).toMatchObject({
      subject: "alice",
      email: "alice@example.com",
    });
    const billingMembership = calls.find((call) =>
      call.sql.includes("FROM billing_account_member")
    );
    expect(String(billingMembership?.params?.billing_account)).toBe(
      "billing_account:team",
    );
    expect(billingMembership?.params?.subject).toBe("alice");
  });

  test("billing account id is not authorization and enumeration stops before workspace listing", async () => {
    const calls: string[] = [];
    const reader = new SurrealQuotaAuthorityReader({
      db: {
        async query(sql) {
          calls.push(sql);
          if (sql.includes("FROM ONLY billing_account")) {
            return [[{
              id: "billing_account:other",
              account_key: "other",
              name: "Other",
            }]];
          }
          if (sql.includes("FROM billing_account_member")) return [[]];
          throw new Error("workspace enumeration must not run");
        },
      },
    });

    await expect(reader.findBillingAuthority({
      accountKey: "other",
      actor: { subject: "stranger" },
    })).resolves.toBeNull();
    expect(calls.some((sql) => sql.includes("FROM quota_subscription_item"))).toBe(false);
  });

  test("billing listing is constrained to subscriptions owned by the authorized account", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const reader = new SurrealQuotaAuthorityReader({
      db: {
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FROM ONLY billing_account")) {
            return [[{
              id: "billing_account:team",
              account_key: "team",
              name: "Team",
            }]];
          }
          if (sql.includes("FROM billing_account_member")) return [["admin"]];
          if (sql.includes("FROM quota_subscription_item")) return [[]];
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await reader.findBillingAuthority({
      accountKey: "team",
      actor: { subject: "payer" },
    });
    expect(result).toEqual({
      account: { accountKey: "team", name: "Team" },
      workspaces: [],
    });
    const listing = calls.find((call) =>
      call.sql.includes("FROM quota_subscription_item")
    );
    expect(listing?.sql).toContain("WHERE billing_account = $billing_account");
    expect(String(listing?.params?.billing_account)).toBe("billing_account:team");
  });
});
