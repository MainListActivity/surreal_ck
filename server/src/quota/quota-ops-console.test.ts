import { describe, expect, test } from "bun:test";
import { SurrealQuotaOpsConsole } from "./quota-ops-console";

const plan = {
  id: "quota_plan_revision:plus_v1",
  plan: {
    id: "quota_plan:plus",
    plan_key: "plus",
    display_name: "Plus",
  },
  revision: 1,
  template_kind: "commercial",
  published_at: "2026-07-01T00:00:00.000Z",
  rules: [{
    rule_key: "record/ent",
    resource: "record",
    selector: { kind: "regex", value: "^ent_" },
    limit: { kind: "finite", value: 100 },
    customer_label: "实体记录",
    customer_description: "ent 开头的表",
  }],
};

function capabilities(sql: string) {
  return sql.includes("FROM platform_operator_capability")
    ? [["quota.read", "override.manage", "reconcile.audit"]]
    : null;
}

describe("SurrealQuotaOpsConsole", () => {
  test("context is unavailable without quota.read and returns plan allowlist when authorized", async () => {
    const denied = new SurrealQuotaOpsConsole({
      db: { async query() { return [[]]; } },
    });
    await expect(denied.getContext({
      actor: { subject: "not-operator" },
    })).resolves.toBeNull();

    const reader = new SurrealQuotaOpsConsole({
      db: {
        async query(sql) {
          const granted = capabilities(sql);
          if (granted) return granted;
          if (sql.includes("FROM quota_plan_revision")) {
            expect(sql).toContain(
              'template_kind INSIDE ["commercial", "contract"]',
            );
            return [[plan]];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });
    const result = await reader.getContext({
      actor: { subject: "operator" },
    });
    expect(result).toMatchObject({
      viewer: {
        capabilities: [
          "override.manage",
          "quota.read",
          "reconcile.audit",
        ],
      },
      plans: [{
        id: "quota_plan_revision:plus_v1",
        plan_key: "plus",
        template_kind: "commercial",
        rules: [{
          rule_key: "record/ent",
          selector: { kind: "regex", value: "^ent_" },
          limit: { kind: "finite", value: 100 },
        }],
      }],
    });
  });

  test("search combines workspace, billing account and subject indexes without business rows", async () => {
    const reader = new SurrealQuotaOpsConsole({
      db: {
        async query(sql) {
          const granted = capabilities(sql);
          if (granted) return granted;
          if (
            sql.includes("FROM workspace\n")
            && sql.includes("string::lowercase(slug)")
          ) {
            return [[{
              id: "workspace:demo",
              slug: "demo",
              name: "Demo",
              applied_entitlement: {
                plan_revision: { plan: { display_name: "Plus" } },
              },
            }]];
          }
          if (
            sql.includes("FROM billing_account\n")
            && sql.includes("string::lowercase(account_key)")
          ) {
            return [[{
              id: "billing_account:acme",
              account_key: "acme",
              name: "Acme",
            }]];
          }
          if (sql.includes("FROM user_workspace_index")) {
            return [[{
              subject: "alice",
              workspace: { slug: "demo" },
            }]];
          }
          if (
            sql.includes("FROM billing_account_member")
            && sql.includes("string::lowercase(subject)")
          ) {
            return [[{
              subject: "alice",
              billing_account: { account_key: "acme" },
            }]];
          }
          if (sql.includes("FROM ONLY workspace_quota_runtime")) {
            return [[{ sync_state: "in_sync", capacity_state: "warning" }]];
          }
          if (
            sql.includes("FROM quota_subscription_item")
            && sql.includes("ORDER BY effective_from")
          ) {
            return [[{
              subscription: {
                billing_account: {
                  id: "billing_account:acme",
                  account_key: "acme",
                  name: "Acme",
                },
              },
            }]];
          }
          if (
            sql.includes("SELECT workspace")
            && sql.includes("quota_subscription_item")
          ) {
            return [[{ workspace: { slug: "demo" } }]];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await reader.search({
      actor: { subject: "operator" },
      query: "a",
      limit: 25,
    });
    expect(result?.results).toEqual([
      {
        kind: "workspace",
        workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
        billing_account: {
          id: "billing_account:acme",
          account_key: "acme",
          name: "Acme",
        },
        applied_plan_name: "Plus",
        sync: "in_sync",
        capacity: "warning",
      },
      {
        kind: "billing_account",
        billing_account: {
          id: "billing_account:acme",
          account_key: "acme",
          name: "Acme",
        },
        workspace_count: 1,
        workspace_slugs: ["demo"],
      },
      {
        kind: "subject",
        subject: "alice",
        workspace_slugs: ["demo"],
        billing_account_keys: ["acme"],
      },
    ]);
  });

  test("malformed record-id-shaped search falls back to text search", async () => {
    const seen: string[] = [];
    const reader = new SurrealQuotaOpsConsole({
      db: {
        async query(sql) {
          const granted = capabilities(sql);
          if (granted) return granted;
          seen.push(sql);
          if (sql.includes("FROM workspace\n")) return [[]];
          if (sql.includes("FROM billing_account\n")) return [[]];
          if (sql.includes("FROM user_workspace_index")) return [[]];
          if (sql.includes("FROM billing_account_member")) return [[]];
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    await expect(reader.search({
      actor: { subject: "operator" },
      query: "workspace:⟨",
      limit: 25,
    })).resolves.toMatchObject({ results: [] });
    expect(seen.some((sql) =>
      sql.includes("string::lowercase(slug)")
    )).toBe(true);
  });

  test("timeline exposes safe operation metadata without error details or provider payload", async () => {
    const reader = new SurrealQuotaOpsConsole({
      db: {
        async query(sql) {
          const granted = capabilities(sql);
          if (granted) return granted;
          if (sql.includes("FROM ONLY workspace")) {
            return [[{
              id: "workspace:demo",
              slug: "demo",
              name: "Demo",
            }]];
          }
          if (sql.includes("FROM quota_operator_intent\n")) {
            return [[{
              id: "quota_operator_intent:req",
              intent_kind: "audit_now",
              actor_subject: "operator",
              authorized_capability: "reconcile.audit",
              request_id: "req",
              correlation_id: "corr",
              created_at: "2026-07-29T10:00:00.000Z",
              input: { secret: "not-returned" },
            }]];
          }
          if (sql.includes("FROM entitlement_operation")) return [[]];
          if (sql.includes("FROM quota_materialization_operation")) return [[]];
          if (sql.includes("FROM quota_audit_event")) {
            return [[{
              id: "quota_audit_event:a",
              event_kind: "native_audit",
              actor_kind: "system",
              correlation_id: "corr-a",
              occurred_at: "2026-07-29T10:01:00.000Z",
              error_details: { secret: "not-returned" },
            }]];
          }
          if (sql.includes("FROM quota_operator_intent_state")) {
            return [[{
              intent: "quota_operator_intent:req",
              state: "processed",
              updated_at: "2026-07-29T10:02:00.000Z",
            }]];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });
    const result = await reader.getTimeline({
      actor: { subject: "operator" },
      slug: "demo",
      limit: 50,
    });
    expect(result?.items.map((item) => item.kind)).toEqual([
      "operator_intent",
      "audit",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("error_details");
    expect(JSON.stringify(result)).not.toContain("input");
  });
});
