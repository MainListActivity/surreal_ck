import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { ProductEntitlementService } from "./service";
import { SurrealProductEntitlementStore } from "./store";

const enabled = process.env.RUN_LOCAL_SURREALDB_PRODUCT_ENTITLEMENT_TESTS === "1";
const localTest = test.skipIf(!enabled);
let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

async function session(): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "main", database: "_system" });
  sessions.push(db);
  return db;
}

beforeAll(async () => {
  if (!enabled) return;
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}`;
  processHandle = Bun.spawn(["surreal", "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", "memory"], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  const root = await session();
  await ensureSystemSchema(root, { namespace: "main" });
  await root.query(`
    CREATE platform_operator:ops SET subject = "ops", kind = "human", status = "active";
    CREATE platform_operator_capability:ops_read SET operator = platform_operator:ops, capability = "quota.read", status = "active", granted_by_subject = "ops";
    CREATE platform_operator_capability:ops_manage SET operator = platform_operator:ops, capability = "subscription.manage", status = "active", granted_by_subject = "ops";
    CREATE billing_account:acct SET account_key = "acct-a", name = "夹具账户", kind = "team", status = "active";
    CREATE workspace:team SET db_name = "ws_team", owner_subject = "lawyer", slug = "team", name = "夹具团队", status = "active";
    CREATE user_workspace_index:lawyer SET subject = "lawyer", workspace = workspace:team, db_name = "ws_team", role = "admin";
    CREATE quota_plan:fixture SET plan_key = "plus", display_name = "Plus 资源", visibility = "internal", status = "active";
    CREATE quota_plan_revision:fixture SET plan = quota_plan:fixture, revision = 1, template_kind = "commercial", rules = [],
      created_by_subject = "ops", published_at = time::now(), correlation_id = "fixture-resource";
    CREATE quota_subscription:team SET billing_account = billing_account:acct, source = "manual", status = "active", revision = 1, correlation_id = "fixture-sub";
    CREATE quota_subscription_item:team SET subscription = quota_subscription:team, workspace = workspace:team, plan_revision = quota_plan_revision:fixture,
      revision = 1, status = "active", effective_from = <datetime>"2026-09-01T00:00:00.000Z", effective_until = <datetime>"2026-10-01T00:00:00.000Z", correlation_id = "fixture-item";
  `).collect();
});

afterAll(async () => {
  await Promise.all(sessions.map((db) => db.close()));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("product entitlement surreal store", () => {
  localTest("夹具版本可分配，旧资源套餐名不会变成内容授权", async () => {
    const store = new SurrealProductEntitlementStore(async () => await session(), "main");
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const operator = { subject: "ops", capabilities: ["subscription.manage", "quota.read"] };
    const before = await service.getForCustomer("lawyer", "team");
    expect(before.summary).toBe("无有效内容授权");
    expect(before.resource.status).toBe("unknown");
    const published = await service.publishRevision(operator, {
      planKey: "fixture_plus", displayName: "夹具律师 Plus", revision: 1, resourceTemplateId: "quota_plan_revision:fixture",
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["browse", "search", "read"], aiActions: ["research"],
      features: [{ key: "audit_export", enabled: true, limit: null }], reason: "发布夹具版本", idempotencyKey: "publish-fixture-001",
    });
    await expect(service.assign(operator, {
      workspaceSlug: "team", billingAccountKey: "acct-b", productPlanRevisionId: published.productPlanRevisionId,
      reason: "错误账户", idempotencyKey: "assign-cross-001",
    })).rejects.toMatchObject({ code: "cross_account" });
    const assigned = await service.assign(operator, {
      workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId: published.productPlanRevisionId,
      reason: "为夹具工作区开通", idempotencyKey: "assign-fixture-001",
    });
    expect(assigned.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    expect(assigned.content.projectionLabel).toBe("待交付");
    expect(assigned.ai.consumableAllowance).toBeNull();
    expect(assigned.baseSource.planKey).toBe("fixture_plus");
    expect(assigned.features).toEqual([{ key: "audit_export", enabled: true, limit: null }]);
    const repeated = await service.assign(operator, {
      workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId: published.productPlanRevisionId,
      reason: "为夹具工作区开通", idempotencyKey: "assign-fixture-001",
    });
    expect(repeated.revision).toBe(assigned.revision);
    await service.publishRevision(operator, {
      planKey: "fixture_plus", displayName: "夹具律师 Plus", revision: 2, resourceTemplateId: "quota_plan_revision:fixture",
      collections: [{ key: "fixture_expanded", label: "夹具扩展" }], actions: ["browse"], aiActions: [],
      features: [], reason: "发布下一夹具版本", idempotencyKey: "publish-fixture-002",
    });
    expect((await service.getForOperator(operator, "team")).content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    const db = await session();
    await db.query(`UPDATE quota_subscription_item:team SET effective_until = <datetime>"2026-09-02T00:00:00.000Z";`).collect();
    const expired = await service.getForCustomer("lawyer", "team");
    expect(expired.summary).toBe("无有效内容授权");
    expect(expired.content.projectionLabel).toBe("无有效内容授权");
    expect(expired.baseSource.kind).toBe("none");
    expect(expired.baseSource.planKey).toBeNull();
    expect(expired.content.collections).toEqual([]);
    expect(expired.revision).toBeGreaterThan(assigned.revision);
    const again = await service.getForCustomer("lawyer", "team");
    expect(again.revision).toBe(expired.revision);
    const history = await db.query(`SELECT id, revision, summary, base_source_kind, product_plan_key, features FROM workspace_product_entitlement WHERE workspace = workspace:team ORDER BY revision;`).collect();
    const snapshots = history[0] as Array<Record<string, unknown>>;
    expect(snapshots.length).toBeGreaterThan(1);
    expect(String(snapshots[0]?.summary)).toContain("待交付");
    expect(snapshots.at(-1)?.base_source_kind).toBe("none");
    expect(snapshots.at(-1)?.product_plan_key ?? null).toBeNull();
    const firstFeatures = snapshots[0]?.features as Array<{ limit_value?: number | null }>;
    expect(firstFeatures[0]?.limit_value ?? null).toBeNull();
    const olderId = typeof snapshots[0]?.id === "string" ? snapshots[0].id : String(snapshots[0]?.id);
    await store.pointWorkspace("workspace:team", olderId);
    const pointer = await db.query(`SELECT VALUE current_product_entitlement.revision FROM ONLY workspace:team;`).collect();
    expect(pointer[0]).toBe(expired.revision);
  });
});
