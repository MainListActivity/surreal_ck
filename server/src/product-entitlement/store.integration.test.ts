import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import type { GrantContentCollection, SessionUser } from "@surreal-ck/shared";
import { ensureSystemSchema } from "../db/system-schema";
import { createContentReaderExchangeHandler } from "../content/reader-handler";
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
  }, 30000);

  localTest("指派到低配产品再恢复同 digest 产品时指针回指旧快照", async () => {
    const db = await session();
    await db.query(`
      CREATE workspace:rollback SET db_name = "ws_rollback", owner_subject = "lawyer", slug = "rollback", name = "回滚夹具", status = "active";
      CREATE user_workspace_index:rollback_lawyer SET subject = "lawyer", workspace = workspace:rollback, db_name = "ws_rollback", role = "admin";
      CREATE quota_subscription:rollback SET billing_account = billing_account:acct, source = "manual", status = "active", revision = 1, correlation_id = "fixture-sub-rollback";
      CREATE quota_subscription_item:rollback SET subscription = quota_subscription:rollback, workspace = workspace:rollback, plan_revision = quota_plan_revision:fixture,
        revision = 1, status = "active", effective_from = <datetime>"2026-09-01T00:00:00.000Z", effective_until = NONE, correlation_id = "fixture-item-rollback";
    `).collect();
    const store = new SurrealProductEntitlementStore(async () => await session(), "main");
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const operator = { subject: "ops", capabilities: ["subscription.manage", "quota.read"] };
    const publish = (planKey: string, displayName: string, actions: string[], idempotencyKey: string) =>
      service.publishRevision(operator, {
        planKey, displayName, revision: 1, resourceTemplateId: "quota_plan_revision:fixture",
        collections: [{ key: "fixture_core", label: "夹具核心" }], actions, aiActions: [],
        features: [], reason: "发布夹具版本", idempotencyKey,
      });
    const assign = (productPlanRevisionId: string, idempotencyKey: string) =>
      service.assign(operator, {
        workspaceSlug: "rollback", billingAccountKey: "acct-a", productPlanRevisionId,
        reason: "指派", idempotencyKey,
      });

    const full = await publish("fixture_full", "夹具全量", ["browse", "search", "read"], "publish-full-001");
    const meta = await publish("fixture_meta", "夹具元数据", ["browse"], "publish-meta-001");

    const first = await assign(full.productPlanRevisionId, "assign-rb-001");
    expect(first.content.actions).toEqual(["browse", "read", "search"]);
    const lowered = await assign(meta.productPlanRevisionId, "assign-rb-002");
    expect(lowered.revision).toBeGreaterThan(first.revision);
    expect(lowered.content.actions).toEqual(["browse"]);

    const restored = await assign(full.productPlanRevisionId, "assign-rb-003");
    expect(restored.revision).toBe(first.revision);
    expect(restored.content.actions).toEqual(["browse", "read", "search"]);
    const pointer = await db.query(`SELECT VALUE current_product_entitlement.revision FROM ONLY workspace:rollback;`).collect();
    expect(pointer[0]).toBe(first.revision);
    const view = await service.getForOperator(operator, "rollback");
    expect(view.revision).toBe(first.revision);
    const projectionWrites: Record<string, unknown>[] = [];
    const nowSeconds = Math.floor(new Date("2026-09-24T00:00:00.000Z").getTime() / 1000);
    const exchange = createContentReaderExchangeHandler({
      nowSeconds: () => nowSeconds,
      database: "platform_content",
      namespace: "main",
      entitlementStore: store,
      getSystemDb: async () => ({
        async query() {
          return [[{ subject: "lawyer", disabled_at: null, workspace: { id: "workspace:rollback", status: "active" } }]];
        },
      }),
      getWorkspaceDb: async () => ({ async query() { return [[{ id: "user:lawyer", disabled_at: null }]]; } }),
      getContentDb: async () => ({
        async query(sql: string, params?: Record<string, unknown>) {
          if (sql.includes("UPSERT")) {
            projectionWrites.push(params ?? {});
            return [null, null];
          }
          return [null, null, null, null, {
            version: "content_version:v", item: "content_item:i", source_status: "active",
            publication_status: "published", license: "source_license_revision:l",
            license_actions: ["browse", "read", "search"],
            license_from: "2026-09-01T00:00:00.000Z", license_until: null,
            collections: ["fixture_core"],
          }];
        },
      }),
      idpContentReader: {
        async exchangeContentReaderScope() { return { accessToken: "content-token", expiresIn: 120 }; },
      },
    });
    const caller: SessionUser = {
      subject: "lawyer", raw: { db: "ws_rollback", ac: "participant", exp: nowSeconds + 5000 }, rawToken: "workspace-token",
    };
    const exchanged = await exchange(caller, { contentPublicId: "fixture-article" });
    expect(exchanged).toMatchObject({ entitlementRevision: String(first.revision), accessToken: "content-token" });
    expect(projectionWrites[0]).toMatchObject({ revisionNumber: first.revision, gateActions: ["browse", "read", "search"] });
    const count = await db.query(`SELECT count() FROM workspace_product_entitlement WHERE workspace = workspace:rollback GROUP ALL;`).collect();
    expect((count[0] as Array<{ count: number }>)[0]?.count).toBe(2);
  }, 30000);

  localTest("赠送到期回指后再次赠送/撤销：序位从最大已存在快照继续（真实唯一索引回归）", async () => {
    const db = await session();
    await db.query(`
      CREATE workspace:grantcycle SET db_name = "ws_grantcycle", owner_subject = "lawyer", slug = "grantcycle", name = "赠送序位夹具", status = "active";
      CREATE user_workspace_index:grantcycle_lawyer SET subject = "lawyer", workspace = workspace:grantcycle, db_name = "ws_grantcycle", role = "admin";
      CREATE quota_subscription:grantcycle SET billing_account = billing_account:acct, source = "manual", status = "active", revision = 1, correlation_id = "fixture-sub-gc";
      CREATE quota_subscription_item:grantcycle SET subscription = quota_subscription:grantcycle, workspace = workspace:grantcycle, plan_revision = quota_plan_revision:fixture,
        revision = 1, status = "active", effective_from = <datetime>"2026-09-01T00:00:00.000Z", effective_until = NONE, correlation_id = "fixture-item-gc";
    `).collect();
    const store = new SurrealProductEntitlementStore(async () => await session(), "main");
    let now = new Date("2026-09-24T00:00:00.000Z");
    const service = new ProductEntitlementService(store, () => now);
    const operator = { subject: "ops", capabilities: ["subscription.manage", "quota.read", "entitlement.gift", "entitlement.repair"] };

    const published = await service.publishRevision(operator, {
      planKey: "fixture_gc", displayName: "赠送序位夹具", revision: 1, resourceTemplateId: "quota_plan_revision:fixture",
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["browse", "search", "read"], aiActions: [],
      features: [], reason: "发布赠送序位夹具版本", idempotencyKey: "publish-gc-001",
    });
    const assigned = await service.assign(operator, {
      workspaceSlug: "grantcycle", billingAccountKey: "acct-a", productPlanRevisionId: published.productPlanRevisionId,
      reason: "指派", idempotencyKey: "assign-gc-001",
    });
    expect(assigned.revision).toBe(1);

    const grant = (key: string, collections: { key: string; label: string }[], window: { from: string; until: string }): GrantContentCollection => ({
      workspaceSlug: "grantcycle", label: "临时赠送", collections, actions: ["cite"],
      effectiveFrom: window.from, effectiveUntil: window.until,
      reason: "赠送序位回归", idempotencyKey: key,
    });

    // 赠送一（窗口覆盖注入的 now）→ 快照 rev 2，指针指向 rev 2。
    const granted = await service.grant(operator, grant("grant-gc-001", [{ key: "fixture_topic", label: "临时专题" }], { from: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" }));
    expect(granted.revision).toBe(2);

    // 注入时间越过错期窗口：读取回退，digest 命中 rev 1，指针回指（最大已存在序位仍为 2）。
    now = new Date("2026-10-15T00:00:00.000Z");
    const reverted = await service.getForCustomer("lawyer", "grantcycle");
    expect(reverted.revision).toBe(1);

    // 再次赠送：真实 (workspace,revision) 唯一索引下，新序位必须从 2+1 继续；
    // 若按指针（1）+1 计算会在 rev 2 上反复冲突，视图/撤销/修复全部 409 死锁。
    const again = await service.grant(operator, grant("grant-gc-002", [{ key: "fixture_topic2", label: "再次专题" }], { from: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" }));
    expect(again.revision).toBe(3);

    // 撤销既有赠送（025 后 action=revoke 可落审计）：同键重放幂等返回同一结果。
    const workspaceRef = await store.workspaceBySlug("grantcycle");
    expect(workspaceRef).toBeDefined();
    const facts = await store.grantFacts(workspaceRef!.id);
    const target = facts.find((row) => row.idempotencyKey === "grant-gc-001");
    expect(target).toBeDefined();
    const revoked = await service.revokeGrant(operator, {
      workspaceSlug: "grantcycle", grantId: target!.id, reason: "回收赠送", idempotencyKey: "revoke-gc-001",
    });
    expect(revoked.after.content.collections.map((item) => item.key)).not.toContain("fixture_topic");
    const replayed = await service.revokeGrant(operator, {
      workspaceSlug: "grantcycle", grantId: target!.id, reason: "回收赠送", idempotencyKey: "revoke-gc-001",
    });
    expect(replayed.after.revision).toBe(revoked.after.revision);
    const audit = await db.query(`SELECT action FROM product_entitlement_audit WHERE actor_subject = "ops" AND idempotency_key = "revoke-gc-001";`).collect();
    const auditRows = audit[0] as Array<{ action: string }>;
    expect(auditRows[0]?.action).toBe("revoke");
  }, 30000);
});
