import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AI_ALLOWANCE_CONSUMABLE_SQL, aiAllowanceConsumptionReason } from "@surreal-ck/shared";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, jsonify, StringRecordId, Surreal } from "surrealdb";
import { AiAllowancePlanCycleSynchronizer } from "../ai-allowance/plan-cycle";
import { AiAllowanceService } from "../ai-allowance/service";
import { ProductEntitlementService, type ProductActor } from "../product-entitlement/service";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { seedQuotaPlans } from "../db/quota-plan-seed";
import { SurrealEntitlementRefreshService } from "./entitlement-refresh";
import {
  QuotaLifecycleCoordinator,
  QuotaLifecycleError,
} from "./subscription-lifecycle";
import { SubscriptionEntitlementCascade } from "./subscription-cascade";
import { SurrealQuotaLifecycleStore } from "./lifecycle-store";
import { ProTrialService } from "../workspaces/pro-trial";
import { SurrealTrialStore } from "../workspaces/pro-trial-store";
import { createWorkspaceCreator } from "../workspaces/create-workspace";

const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_QUOTA_LIFECYCLE_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const migrationsUrl = new URL("../../../shared/sql/system/", import.meta.url);

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;
let workspaceDb: Surreal | undefined;

function id(value: string): StringRecordId {
  return new StringRecordId(value);
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate SurrealDB port"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn(
      [surrealBinary, "is-ready", "--endpoint", endpoint],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await probe.exited) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

function queryClient() {
  if (!db) throw new Error("integration database not initialized");
  return {
    query: async <T = unknown>(
      sql: string,
      params?: Record<string, unknown>,
    ): Promise<T> => await db!.query(sql, params) as T,
  };
}

function rows(result: unknown, statement = 0): Record<string, unknown>[] {
  const value = Array.isArray(result) ? result[statement] : undefined;
  const normalized = jsonify(value);
  if (Array.isArray(normalized)) {
    return normalized as Record<string, unknown>[];
  }
  return typeof normalized === "object" && normalized !== null
    ? [normalized as Record<string, unknown>]
    : [];
}

async function connect(databaseName?: string): Promise<Surreal> {
  const session = new Surreal();
  await session.connect(`${endpoint}/rpc`, {
    authentication: { username: "root", password: "root" },
  });
  await session.use({
    namespace,
    database: databaseName,
  });
  return session;
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-lca08-cascade-"));
  const port = await allocatePort();
  endpoint = `ws://127.0.0.1:${port}`;
  server = Bun.spawn(
    [
      surrealBinary,
      "start",
      "--no-banner",
      "--log",
      "none",
      "--bind",
      `127.0.0.1:${port}`,
      "--user",
      "root",
      "--pass",
      "root",
      `rocksdb:${join(workingDirectory, "data")}`,
    ],
    { cwd: workingDirectory, stdout: "ignore", stderr: "ignore" },
  );
  await waitUntilReady();

  db = await connect(database);
  await db.query(`DEFINE DATABASE IF NOT EXISTS ws_lca08;`);
  const migrations = (await readdir(migrationsUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  for (const migration of migrations) {
    await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
  }
  await seedQuotaPlans({
    namespace,
    createdBySubject: "system:test",
    getDbSession: async () => queryClient(),
  });

  workspaceDb = await connect("ws_lca08");
  for (const script of ["035-ai-allowance.surql", "042-ai-plan-upgrade-proration.surql", "047-ai-source-termination.surql"]) {
    await workspaceDb.query(
      await readFile(
        new URL(`../../../shared/sql/workspace-template/${script}`, import.meta.url),
        "utf8",
      ),
    );
  }

  await db.query(`
    CREATE workspace:lca08 CONTENT {
      db_name: "ws_lca08",
      owner_subject: "operator:carol",
      slug: "lca08",
      name: "LCA08",
      status: "active"
    };
    CREATE billing_account:lca08 CONTENT {
      account_key: "lca08",
      name: "LCA08 Billing",
      kind: "team",
      status: "active"
    };
    CREATE quota_subscription:lca08sub CONTENT {
      billing_account: billing_account:lca08,
      source: "manual",
      status: "active",
      revision: 0,
      current_period_start: <datetime> "2026-09-01T00:00:00.000Z",
      current_period_end: <datetime> "2026-10-01T00:00:00.000Z",
      correlation_id: "fixture-lca08"
    };
    CREATE quota_subscription_item:lca08item CONTENT {
      subscription: quota_subscription:lca08sub,
      workspace: workspace:lca08,
      plan_revision: quota_plan_revision:plus_v1,
      revision: 0,
      status: "active",
      effective_from: <datetime> "2026-09-01T00:00:00.000Z",
      effective_until: <datetime> "2026-10-01T00:00:00.000Z",
      active_workspace: workspace:lca08,
      correlation_id: "fixture-lca08"
    };
  `);
});

afterAll(async () => {
  await workspaceDb?.close();
  await db?.close();
  server?.kill();
  if (server) await server.exited;
  if (workingDirectory) {
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

describe("subscription cascade against local SurrealDB (LCA08)", () => {
  localTest(
    "assigns, upgrades, expires and recovers product entitlements with plan-cycle AI buckets",
    async () => {
      const client = queryClient();
      const productStore = new SurrealProductEntitlementStore(
        async () => client,
        namespace,
      );
      const products = new ProductEntitlementService(
        productStore,
        () => new Date("2026-09-24T00:00:00.000Z"),
      );
      const operator: ProductActor = {
        subject: "operator:carol",
        capabilities: ["subscription.manage", "quota.read"],
      };
      const synchronizer = new AiAllowancePlanCycleSynchronizer({
        workspaceSession: async () => {
          if (!workspaceDb) throw new Error("workspace database missing");
          return workspaceDb;
        },
      });
      const cascade = new SubscriptionEntitlementCascade(
        new SurrealEntitlementRefreshService(client),
        products,
        synchronizer,
      );
      const refresh = (correlationId: string) =>
        cascade.refreshWorkspace({
          workspace: id("workspace:lca08"),
          at: new DateTime("2026-09-24T00:00:00.000Z"),
          operationKind: "manual_assignment",
          actorKind: "operator",
          actorSubject: "operator:carol",
          authorizedCapability: "subscription.manage",
          correlationId,
          causationId: `causation:${correlationId}`,
        });

      // ── 1. 发布产品修订（含周期额度 feature）并按运营指派绑定 ─────────────
      const rev1 = await products.publishRevision(operator, {
        planKey: "fixture_plus",
        displayName: "夹具律师 Plus",
        revision: 1,
        resourceTemplateId: "quota_plan_revision:plus_v1",
        collections: [{ key: "fixture_core", label: "夹具核心" }],
        actions: ["browse", "search", "read"],
        aiActions: ["research"],
        features: [{ key: "ai_cycle_allowance", enabled: true, limit: 200 }],
        reason: "LCA08 夹具发布",
        idempotencyKey: "lca08-publish-1",
      });
      await products.assign(operator, {
        workspaceSlug: "lca08",
        billingAccountKey: "lca08",
        productPlanRevisionId: rev1.productPlanRevisionId,
        reason: "LCA08 夹具指派",
        idempotencyKey: "lca08-assign-1",
      });

      // ── 2. 级联刷新 #1：快照 digest 未变，但周期额度桶首次落地 ────────────
      await refresh("cascade-1");
      const snapshotRows = rows(
        await db!.query(
          `SELECT revision, digest, base_source_kind, product_plan_key
           FROM workspace_product_entitlement
           WHERE workspace = workspace:lca08 ORDER BY revision;`,
        ),
      );
      expect(snapshotRows).toHaveLength(1);
      expect(snapshotRows[0]).toMatchObject({
        revision: 1,
        base_source_kind: "subscription",
        product_plan_key: "fixture_plus",
      });
      let buckets = rows(
        await workspaceDb!.query(
          `SELECT kind, label, period_key, total, available, expires_at
           FROM ai_allowance_bucket ORDER BY period_key;`,
        ),
      );
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({
        kind: "plan_cycle",
        total: 200,
        available: 200,
      });
      expect(String(buckets[0]!.period_key)).toContain(
        "quota_subscription:lca08sub:2026-09-01",
      );
      expect(new Date(String(buckets[0]!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      let grants = rows(
        await workspaceDb!.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant";`,
        ),
      );
      expect(grants.map((grant) => grant.amount)).toEqual([200]);

      // ── 3. 周期内升级：独立补发桶按剩余周期折算（item 生效 9/1 → 全周期差额
      //      150），基础桶保持原授予，桶到期边界不变，重复刷新不重复补 ──────
      const rev2 = await products.publishRevision(operator, {
        planKey: "fixture_plus",
        displayName: "夹具律师 Plus",
        revision: 2,
        resourceTemplateId: "quota_plan_revision:plus_v1",
        collections: [
          { key: "fixture_core", label: "夹具核心" },
          { key: "fixture_expanded", label: "夹具扩展" },
        ],
        actions: ["browse", "search", "read"],
        aiActions: ["research"],
        features: [{ key: "ai_cycle_allowance", enabled: true, limit: 350 }],
        reason: "LCA08 夹具升级",
        idempotencyKey: "lca08-publish-2",
      });
      await productStore.bindProductRevision(
        "quota_subscription_item:lca08item",
        rev2.productPlanRevisionId,
      );
      await refresh("cascade-2");
      buckets = rows(
        await workspaceDb!.query(
          `SELECT total, available, expires_at, upgrade_event_key, created_at FROM ai_allowance_bucket ORDER BY created_at;`,
        ),
      );
      expect(buckets).toHaveLength(2);
      expect(buckets[0]).toMatchObject({ total: 200, available: 200 });
      expect(buckets[1]).toMatchObject({ total: 150, available: 150 });
      expect(buckets[1]?.upgrade_event_key).toBe("quota_subscription_item:lca08item");
      for (const bucket of buckets) {
        expect(new Date(String(bucket.expires_at)).toISOString()).toBe(
          "2026-10-01T00:00:00.000Z",
        );
      }
      grants = rows(
        await workspaceDb!.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant" ORDER BY amount;`,
        ),
      );
      expect(grants.map((grant) => grant.amount)).toEqual([150, 200]);

      const rerun = await refresh("cascade-2-repeat");
      expect(rerun).toMatchObject({});
      buckets = rows(
        await workspaceDb!.query(
          `SELECT total, available, created_at FROM ai_allowance_bucket ORDER BY created_at;`,
        ),
      );
      expect(buckets).toHaveLength(2);
      expect(buckets[0]).toMatchObject({ total: 200, available: 200 });
      expect(buckets[1]).toMatchObject({ total: 150, available: 150 });
      grants = rows(
        await workspaceDb!.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant";`,
        ),
      );
      expect(grants).toHaveLength(2);

      // 升级后快照跟随新产品修订（集合扩大）
      const upgradedPointer = rows(
        await db!.query(
          `SELECT current_product_entitlement.* FROM ONLY workspace:lca08;`,
        ),
      );
      expect(upgradedPointer[0]?.current_product_entitlement).toMatchObject({
        revision: 2,
        product_plan_key: "fixture_plus",
      });

      // ── 4. 到期：订阅失效 → 快照进入无有效内容授权，桶不被触碰/重置 ──────
      await db!.query(`
        UPDATE quota_subscription_item:lca08item SET
          status = "ended", ended_reason = "expired", active_workspace = NONE;
        UPDATE quota_subscription:lca08sub SET status = "expired";
      `);
      await refresh("cascade-3");
      const expiredPointer = rows(
        await db!.query(
          `SELECT current_product_entitlement.* FROM ONLY workspace:lca08;`,
        ),
      );
      expect(expiredPointer[0]?.current_product_entitlement).toMatchObject({
        base_source_kind: "none",
      });
      buckets = rows(
        await workspaceDb!.query(
          `SELECT total, available, expires_at, created_at FROM ai_allowance_bucket ORDER BY created_at;`,
        ),
      );
      expect(buckets).toHaveLength(2);
      expect(buckets[0]).toMatchObject({ total: 200, available: 200 });
      expect(buckets[1]).toMatchObject({ total: 150, available: 150 });
      expect(new Date(String(buckets[0]!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      grants = rows(
        await workspaceDb!.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant";`,
        ),
      );
      expect(grants).toHaveLength(2);

      // ── 5. 续订恢复：新订阅新周期 → 新桶新周期键，旧余额不结转不复活 ──────
      await db!.query(`
        CREATE quota_subscription:lca08sub2 CONTENT {
          billing_account: billing_account:lca08,
          source: "manual",
          status: "active",
          revision: 0,
          current_period_start: <datetime> "2026-09-20T00:00:00.000Z",
          current_period_end: <datetime> "2026-10-20T00:00:00.000Z",
          correlation_id: "fixture-lca08-renewal"
        };
        CREATE quota_subscription_item:lca08item2 CONTENT {
          subscription: quota_subscription:lca08sub2,
          workspace: workspace:lca08,
          plan_revision: quota_plan_revision:plus_v1,
          revision: 0,
          status: "active",
          effective_from: <datetime> "2026-09-20T00:00:00.000Z",
          effective_until: <datetime> "2026-10-20T00:00:00.000Z",
          active_workspace: workspace:lca08,
          correlation_id: "fixture-lca08-renewal"
        };
      `);
      await productStore.bindProductRevision(
        "quota_subscription_item:lca08item2",
        rev2.productPlanRevisionId,
      );
      await refresh("cascade-4");
      buckets = rows(
        await workspaceDb!.query(
          `SELECT kind, period_key, total, available, expires_at, created_at
           FROM ai_allowance_bucket ORDER BY created_at;`,
        ),
      );
      expect(buckets).toHaveLength(3);
      const previousBase = buckets.find((bucket) =>
        String(bucket.period_key).includes("quota_subscription:lca08sub:2026-09-01") && Number(bucket.total) === 200,
      );
      const previousSupplement = buckets.find((bucket) =>
        String(bucket.period_key).includes("quota_subscription:lca08sub:2026-09-01") && Number(bucket.total) === 150,
      );
      const renewedPeriod = buckets.find((bucket) =>
        String(bucket.period_key).includes("quota_subscription:lca08sub2:2026-09-20"),
      );
      expect(previousBase).toMatchObject({ available: 200 });
      expect(new Date(String(previousBase!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(previousSupplement).toMatchObject({ available: 150 });
      expect(new Date(String(previousSupplement!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(renewedPeriod).toMatchObject({ total: 350, available: 350 });
      expect(new Date(String(renewedPeriod!.expires_at)).toISOString()).toBe(
        "2026-10-20T00:00:00.000Z",
      );
      grants = rows(
        await workspaceDb!.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant";`,
        ),
      );
      expect(grants).toHaveLength(3);
      const renewedPointer = rows(
        await db!.query(
          `SELECT current_product_entitlement.* FROM ONLY workspace:lca08;`,
        ),
      );
      expect(renewedPointer[0]?.current_product_entitlement).toMatchObject({
        base_source_kind: "subscription",
        product_plan_key: "fixture_plus",
      });

      // ── 6. 受保护商业入口：普通成员/无能力者不能伪造商业来源 ─────────────
      const lifecycleStore = new SurrealQuotaLifecycleStore(client);
      const coordinator = new QuotaLifecycleCoordinator(
        lifecycleStore,
        new SurrealEntitlementRefreshService(client),
        "worker-test",
      );
      const effectiveAt = new DateTime("2026-09-24T00:00:00.000Z");
      await expect(
        coordinator.submitOperatorIntent({
          kind: "subscription_upsert",
          actorSubject: "member:eve",
          actorCapability: "quota.read",
          requestId: "forged-1",
          workspace: id("workspace:lca08"),
          customerReason: "伪造升级",
          operatorReason: "越权提交",
          effectiveAt,
          input: { mode: "manual_assignment", workspace: id("workspace:lca08") },
          impactPreview: {},
          correlationId: "corr-forged-1",
        }),
      ).rejects.toThrow(/requires subscription\.manage/u);

            // 商业来源只能经受保护入口进入：运营意图按能力拒绝（上方断言）、
      // provider 事件走签名 inbox；额度账本表 PERMISSIONS 对成员会话全部
      // 关闭、仅 root 服务可写（LCA05 已验收的账本完整性不变量），普通成员
      // 没有可伪造订阅、权益快照或额度的写入路径。
      const finalBuckets = rows(
        await workspaceDb!.query(
          `SELECT period_key, total FROM ai_allowance_bucket;`,
        ),
      );
      expect(finalBuckets).toHaveLength(3);
    },
    120_000,
  );

  localTest(
    "real commercial entries: operator plan_rollout keeps product binding and cycles, provider renewal extends item window, past_due recovers",
    async () => {
      // ── 0. 夹具：provider 关联订阅 + 首个 item（root 造初始态）────────────
      await db!.query(`DEFINE DATABASE IF NOT EXISTS ws_lca08b;`);
      const wsB = await connect("ws_lca08b");
      for (const script of ["035-ai-allowance.surql", "042-ai-plan-upgrade-proration.surql", "047-ai-source-termination.surql"]) {
        await wsB.query(
          await readFile(
            new URL(`../../../shared/sql/workspace-template/${script}`, import.meta.url),
            "utf8",
          ),
        );
      }
      await db!.query(`
        CREATE billing_account:lca08b CONTENT {
          account_key: "lca08b",
          name: "LCA08B Billing",
          kind: "team",
          status: "active"
        };
        CREATE workspace:lca08b CONTENT {
          db_name: "ws_lca08b",
          owner_subject: "operator:carol",
          slug: "lca08b",
          name: "LCA08B",
          status: "active"
        };
        CREATE user_workspace_index:carol_lca08b CONTENT {
          subject: "operator:carol",
          workspace: workspace:lca08b,
          db_name: "ws_lca08b",
          role: "admin"
        };
        CREATE billing_account_member:carol_lca08b CONTENT {
          billing_account: billing_account:lca08b,
          subject: "operator:carol",
          role: "owner",
          status: "active"
        };
        CREATE platform_operator:carol CONTENT {
          subject: "operator:carol",
          display_name: "Carol",
          status: "active"
        };
        CREATE platform_operator_capability:carol_subscription CONTENT {
          operator: platform_operator:carol,
          capability: "subscription.manage",
          status: "active",
          granted_by_subject: "system:test"
        };
        CREATE platform_operator_capability:carol_quota_read CONTENT {
          operator: platform_operator:carol,
          capability: "quota.read",
          status: "active",
          granted_by_subject: "system:test"
        };
        CREATE quota_subscription:lca08bsub CONTENT {
          billing_account: billing_account:lca08b,
          source: "provider",
          status: "active",
          revision: 1,
          provider: "fixture_provider",
          provider_customer_id: "cus_lca08b",
          provider_subscription_id: "sub_lca08b_1",
          provider_source_revision: 1,
          current_period_start: <datetime> "2026-09-01T00:00:00.000Z",
          current_period_end: <datetime> "2026-10-01T00:00:00.000Z",
          cancel_at_period_end: false,
          correlation_id: "fixture-lca08b"
        };
        CREATE quota_subscription_item:lca08bitem CONTENT {
          subscription: quota_subscription:lca08bsub,
          workspace: workspace:lca08b,
          plan_revision: quota_plan_revision:plus_v1,
          revision: 1,
          status: "active",
          effective_from: <datetime> "2026-09-01T00:00:00.000Z",
          effective_until: <datetime> "2026-10-01T00:00:00.000Z",
          active_workspace: workspace:lca08b,
          correlation_id: "fixture-lca08b"
        };
      `);

      const client = queryClient();
      const productStore = new SurrealProductEntitlementStore(
        async () => client,
        namespace,
      );
      const products = new ProductEntitlementService(
        productStore,
        () => new Date("2026-09-24T00:00:00.000Z"),
      );
      const operator: ProductActor = {
        subject: "operator:carol",
        capabilities: ["subscription.manage", "quota.read"],
      };
      const synchronizer = new AiAllowancePlanCycleSynchronizer({
        workspaceSession: async (dbName) => {
          if (dbName === "ws_lca08b") return wsB;
          if (!workspaceDb) throw new Error("workspace database missing");
          return workspaceDb;
        },
      });
      // 真实链路：coordinator（运营意图/provider 事件）→ 级联 → 产品快照 → 周期桶。
      const cascade = new SubscriptionEntitlementCascade(
        new SurrealEntitlementRefreshService(client),
        products,
        synchronizer,
      );
      let lifecycleNow = new DateTime("2026-09-24T00:00:00.000Z");
      const coordinator = new QuotaLifecycleCoordinator(
        new SurrealQuotaLifecycleStore(client),
        cascade,
        "worker-lca08b",
        undefined,
        { clock: { now: () => lifecycleNow } },
      );

      // ── 1. 产品指派走真实运营入口：产品绑定落在活跃 item 上，首桶 200 ─────
      const rev1 = await products.publishRevision(operator, {
        planKey: "fixture_pro",
        displayName: "夹具律师 Pro",
        revision: 1,
        resourceTemplateId: "quota_plan_revision:plus_v1",
        collections: [{ key: "pro_core", label: "Pro 核心" }],
        actions: ["browse", "search", "read"],
        aiActions: ["research"],
        features: [{ key: "ai_cycle_allowance", enabled: true, limit: 200 }],
        reason: "LCA08 真实入口夹具发布",
        idempotencyKey: "lca08b-publish-1",
      });
      await products.assign(operator, {
        workspaceSlug: "lca08b",
        billingAccountKey: "lca08b",
        productPlanRevisionId: rev1.productPlanRevisionId,
        reason: "LCA08 真实入口夹具指派",
        idempotencyKey: "lca08b-assign-1",
      });
      // 指派后的快照刷新与周期桶落地：与 lifecycle 事件同一入口（级联）。
      await cascade.refreshWorkspace({
        workspace: id("workspace:lca08b"),
        at: new DateTime("2026-09-24T00:00:00.000Z"),
        operationKind: "manual_assignment",
        actorKind: "operator",
        actorSubject: "operator:carol",
        authorizedCapability: "subscription.manage",
        correlationId: "corr-lca08b-assign",
        causationId: "causation:lca08b-assign",
      });
      const boundItem = rows(
        await db!.query(
          `SELECT product_plan_revision, effective_until FROM ONLY quota_subscription_item:lca08bitem;`,
        ),
      )[0];
      expect(String(boundItem?.product_plan_revision)).toBe(
        rev1.productPlanRevisionId,
      );
      let buckets = rows(
        await wsB.query(
          `SELECT period_key, total, available, expires_at FROM ai_allowance_bucket;`,
        ),
      );
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({ total: 200, available: 200 });
      expect(String(buckets[0]!.period_key)).toBe(
        "subscription:quota_subscription:lca08bsub:2026-09-01T00:00:00.000Z",
      );
      expect(new Date(String(buckets[0]!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );

      // ── 2. 真实运营入口周期内升级：新 item 保留产品绑定并对齐订阅付费窗口，
      //      周期键不变；升级 item 生效于 9/24 → 剩余 7/30 → 独立补发桶 35，
      //      基础桶保持 200，桶到期边界不变 ────────────────────────────────
      const rev2 = await products.publishRevision(operator, {
        planKey: "fixture_pro",
        displayName: "夹具律师 Pro",
        revision: 2,
        resourceTemplateId: "quota_plan_revision:plus_v1",
        collections: [
          { key: "pro_core", label: "Pro 核心" },
          { key: "pro_expanded", label: "Pro 扩展" },
        ],
        actions: ["browse", "search", "read"],
        aiActions: ["research"],
        features: [{ key: "ai_cycle_allowance", enabled: true, limit: 350 }],
        reason: "LCA08 真实入口升级发布",
        idempotencyKey: "lca08b-publish-2",
      });
      await coordinator.submitOperatorIntent({
        kind: "subscription_upsert",
        actorSubject: "operator:carol",
        actorCapability: "subscription.manage",
        requestId: "lca08b-rollout-rev2",
        workspace: id("workspace:lca08b"),
        billingAccount: id("billing_account:lca08b"),
        customerReason: "客户要求升级到 Pro r2",
        operatorReason: "LCA08 真实入口 plan_rollout",
        effectiveAt: new DateTime("2026-09-24T00:00:00.000Z"),
        input: {
          mode: "plan_rollout",
          workspace: id("workspace:lca08b"),
          billing_account: id("billing_account:lca08b"),
          plan_revision: id("quota_plan_revision:plus_v1"),
          product_plan_revision: id(rev2.productPlanRevisionId),
          status: "active",
        },
        impactPreview: { from: "fixture_pro:1", to: "fixture_pro:2" },
        correlationId: "corr-lca08b-rollout-rev2",
      });
      await expect(
        coordinator.processNextOperatorIntent(),
      ).resolves.toBe("processed");
      const upgradedItems = rows(
        await db!.query(
          `SELECT id, product_plan_revision, effective_from, effective_until, status
           FROM quota_subscription_item
           WHERE active_workspace = workspace:lca08b;`,
        ),
      );
      expect(upgradedItems).toHaveLength(1);
      expect(String(upgradedItems[0]!.product_plan_revision)).toBe(
        rev2.productPlanRevisionId,
      );
      expect(new Date(String(upgradedItems[0]!.effective_from)).toISOString()).toBe(
        "2026-09-24T00:00:00.000Z",
      );
      // R1：升级 item 的产品窗口对齐订阅付费窗口（10/1），而非从 9/24 悬空。
      expect(new Date(String(upgradedItems[0]!.effective_until)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      buckets = rows(
        await wsB.query(
          `SELECT period_key, total, available, expires_at, upgrade_event_key, upgrade_target, created_at
           FROM ai_allowance_bucket ORDER BY created_at;`,
        ),
      );
      expect(buckets).toHaveLength(2);
      expect(buckets[0]).toMatchObject({ total: 200, available: 200 });
      expect(buckets[1]).toMatchObject({
        total: 35,
        available: 35,
        upgrade_target: 350,
      });
      expect(String(buckets[1]!.upgrade_event_key)).toContain("quota_subscription_item:");
      for (const bucket of buckets) {
        expect(String(bucket.period_key)).toBe(
          "subscription:quota_subscription:lca08bsub:2026-09-01T00:00:00.000Z",
        );
        expect(new Date(String(bucket.expires_at)).toISOString()).toBe(
          "2026-10-01T00:00:00.000Z",
        );
      }
      let grants = rows(
        await wsB.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant" ORDER BY amount;`,
        ),
      );
      expect(grants.map((grant) => grant.amount)).toEqual([35, 200]);

      // ── 3. 真实 provider 入口续期：item 窗口随付费窗口延长，产品绑定保留，
      //      新周期键新桶，旧桶不结转 ────────────────────────────────────
      lifecycleNow = new DateTime("2026-10-01T00:00:00.000Z");
      await coordinator.ingestProviderEvent({
        provider: "fixture_provider",
        eventId: "evt-renew-1",
        eventType: "customer.subscription.updated",
        providerObjectId: "sub_lca08b_1",
        payloadDigest: "digest-renew-1",
        safePayload: { object_kind: "subscription" },
        signatureVerifiedAt: lifecycleNow,
        correlationId: "corr-lca08b-renew-1",
        snapshot: {
          billingAccount: id("billing_account:lca08b"),
          providerCustomerId: "cus_lca08b",
          providerSubscriptionId: "sub_lca08b_1",
          sourceRevision: 2,
          status: "active",
          currentPeriodStart: new DateTime("2026-10-01T00:00:00.000Z"),
          currentPeriodEnd: new DateTime("2026-11-01T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
        },
      });
      await expect(
        coordinator.processNextProviderEvent(),
      ).resolves.toBe("processed");
      const renewedItems = rows(
        await db!.query(
          `SELECT product_plan_revision, effective_until, status
           FROM quota_subscription_item
           WHERE active_workspace = workspace:lca08b;`,
        ),
      );
      expect(renewedItems).toHaveLength(1);
      expect(String(renewedItems[0]!.product_plan_revision)).toBe(
        rev2.productPlanRevisionId,
      );
      // R1 provider 侧：续期把 item 窗口从 10/1 延长到 11/1，产品绑定不被触碰。
      expect(new Date(String(renewedItems[0]!.effective_until)).toISOString()).toBe(
        "2026-11-01T00:00:00.000Z",
      );
      buckets = rows(
        await wsB.query(
          `SELECT period_key, total, expires_at, created_at FROM ai_allowance_bucket ORDER BY created_at;`,
        ),
      );
      expect(buckets).toHaveLength(3);
      const oldBase = buckets.find((bucket) =>
        String(bucket.period_key).endsWith("2026-09-01T00:00:00.000Z") && Number(bucket.total) === 200,
      );
      const oldSupplement = buckets.find((bucket) =>
        String(bucket.period_key).endsWith("2026-09-01T00:00:00.000Z") && Number(bucket.total) === 35,
      );
      const newPeriod = buckets.find((bucket) =>
        String(bucket.period_key).endsWith("2026-10-01T00:00:00.000Z"),
      );
      expect(oldBase).toMatchObject({ total: 200 });
      expect(new Date(String(oldBase!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(oldSupplement).toMatchObject({ total: 35 });
      expect(new Date(String(oldSupplement!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(newPeriod).toMatchObject({ total: 350 });
      expect(new Date(String(newPeriod!.expires_at)).toISOString()).toBe(
        "2026-11-01T00:00:00.000Z",
      );
      grants = rows(
        await wsB.query(
          `SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant" ORDER BY amount;`,
        ),
      );
      expect(grants.map((grant) => grant.amount)).toEqual([35, 200, 350]);

      // ── 4. 重复/乱序 provider 事件：旧修订被 stale_ignored，不重复授予 ─────
      await coordinator.ingestProviderEvent({
        provider: "fixture_provider",
        eventId: "evt-renew-dup",
        eventType: "customer.subscription.updated",
        providerObjectId: "sub_lca08b_1",
        payloadDigest: "digest-renew-dup",
        safePayload: { object_kind: "subscription" },
        signatureVerifiedAt: lifecycleNow,
        correlationId: "corr-lca08b-renew-dup",
        snapshot: {
          billingAccount: id("billing_account:lca08b"),
          providerCustomerId: "cus_lca08b",
          providerSubscriptionId: "sub_lca08b_1",
          sourceRevision: 2,
          status: "active",
          currentPeriodStart: new DateTime("2026-10-01T00:00:00.000Z"),
          currentPeriodEnd: new DateTime("2026-11-01T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
        },
      });
      await expect(
        coordinator.processNextProviderEvent(),
      ).resolves.toBe("stale_ignored");
      buckets = rows(
        await wsB.query(`SELECT period_key FROM ai_allowance_bucket;`),
      );
      expect(buckets).toHaveLength(3);
      grants = rows(
        await wsB.query(`SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant";`),
      );
      expect(grants).toHaveLength(3);

      // ── 5. 续费失败（past_due）：权益清空、桶保留；恢复后回指既有快照，
      //      同周期恢复不重复授予 ────────────────────────────────────────
      await coordinator.ingestProviderEvent({
        provider: "fixture_provider",
        eventId: "evt-past-due",
        eventType: "customer.subscription.updated",
        providerObjectId: "sub_lca08b_1",
        payloadDigest: "digest-past-due",
        safePayload: { object_kind: "subscription" },
        signatureVerifiedAt: lifecycleNow,
        correlationId: "corr-lca08b-past-due",
        snapshot: {
          billingAccount: id("billing_account:lca08b"),
          providerCustomerId: "cus_lca08b",
          providerSubscriptionId: "sub_lca08b_1",
          sourceRevision: 3,
          status: "past_due",
          currentPeriodStart: new DateTime("2026-11-01T00:00:00.000Z"),
          currentPeriodEnd: new DateTime("2026-12-01T00:00:00.000Z"),
          graceUntil: new DateTime("2026-11-08T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
        },
      });
      await expect(
        coordinator.processNextProviderEvent(),
      ).resolves.toBe("processed");
      const pastDuePointer = rows(
        await db!.query(
          `SELECT current_product_entitlement.* FROM ONLY workspace:lca08b;`,
        ),
      );
      expect(pastDuePointer[0]?.current_product_entitlement).toMatchObject({
        base_source_kind: "none",
      });
      buckets = rows(
        await wsB.query(`SELECT period_key, total FROM ai_allowance_bucket ORDER BY period_key;`),
      );
      expect(buckets).toHaveLength(3);

      await coordinator.ingestProviderEvent({
        provider: "fixture_provider",
        eventId: "evt-recovered",
        eventType: "customer.subscription.updated",
        providerObjectId: "sub_lca08b_1",
        payloadDigest: "digest-recovered",
        safePayload: { object_kind: "subscription" },
        signatureVerifiedAt: lifecycleNow,
        correlationId: "corr-lca08b-recovered",
        snapshot: {
          billingAccount: id("billing_account:lca08b"),
          providerCustomerId: "cus_lca08b",
          providerSubscriptionId: "sub_lca08b_1",
          sourceRevision: 4,
          status: "active",
          currentPeriodStart: new DateTime("2026-11-01T00:00:00.000Z"),
          currentPeriodEnd: new DateTime("2026-12-01T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
        },
      });
      await expect(
        coordinator.processNextProviderEvent(),
      ).resolves.toBe("processed");
      const recoveredPointer = rows(
        await db!.query(
          `SELECT current_product_entitlement.* FROM ONLY workspace:lca08b;`,
        ),
      );
      expect(recoveredPointer[0]?.current_product_entitlement).toMatchObject({
        base_source_kind: "subscription",
        product_plan_key: "fixture_pro",
      });
      buckets = rows(
        await wsB.query(`SELECT period_key, total, expires_at, created_at FROM ai_allowance_bucket ORDER BY created_at;`),
      );
      expect(buckets).toHaveLength(4);
      const recoveredPeriod = buckets.find((bucket) =>
        String(bucket.period_key).endsWith("2026-11-01T00:00:00.000Z"),
      );
      expect(recoveredPeriod).toMatchObject({ total: 350 });
      expect(new Date(String(recoveredPeriod!.expires_at)).toISOString()).toBe(
        "2026-12-01T00:00:00.000Z",
      );
      grants = rows(
        await wsB.query(`SELECT kind, amount FROM ai_ledger_entry WHERE kind = "grant" ORDER BY amount;`),
      );
      expect(grants.map((grant) => grant.amount)).toEqual([35, 200, 350, 350]);

      await wsB.close();
    },
    120_000,
  );

  localTest(
    "AC5 trial→paid on real entries: conversion terminates trial bucket, new reserves use paid bucket, release only writes off, purchased/compensation untouched",
    async () => {
      // ── 0. 夹具：provider 试用订阅（trialing），相对当前时间的未来窗口 ────
      await db!.query(`DEFINE DATABASE IF NOT EXISTS ws_lca08c;`);
      const wsC = await connect("ws_lca08c");
      for (const script of ["035-ai-allowance.surql", "042-ai-plan-upgrade-proration.surql", "047-ai-source-termination.surql"]) {
        await wsC.query(
          await readFile(
            new URL(`../../../shared/sql/workspace-template/${script}`, import.meta.url),
            "utf8",
          ),
        );
      }
      const nowMs = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const trialStart = iso(nowMs - 10 * 86_400_000);
      const trialEnd = iso(nowMs + 20 * 86_400_000);
      const paidStart = iso(nowMs);
      const paidEnd = iso(nowMs + 30 * 86_400_000);
      const purchasedEnd = iso(nowMs + 90 * 86_400_000);
      await db!.query(`
        CREATE billing_account:lca08c CONTENT {
          account_key: "lca08c", name: "LCA08C Billing", kind: "team", status: "active"
        };
        CREATE workspace:lca08c CONTENT {
          db_name: "ws_lca08c", owner_subject: "operator:carol", slug: "lca08c",
          name: "LCA08C", status: "active"
        };
        CREATE user:member_c CONTENT { subject: "member_c", email: "mc@x", kind: "human", is_admin: false };
        CREATE quota_subscription:lca08csub CONTENT {
          billing_account: billing_account:lca08c, source: "provider", status: "trialing",
          revision: 1, provider: "fixture_provider", provider_customer_id: "cus_lca08c",
          provider_subscription_id: "sub_lca08c_1", provider_source_revision: 1,
          trial_start: <datetime> "${trialStart}", trial_end: <datetime> "${trialEnd}",
          current_period_start: <datetime> "${trialStart}", current_period_end: <datetime> "${trialEnd}",
          cancel_at_period_end: false, correlation_id: "fixture-lca08c"
        };
        CREATE quota_subscription_item:lca08citem CONTENT {
          subscription: quota_subscription:lca08csub, workspace: workspace:lca08c,
          plan_revision: quota_plan_revision:plus_v1, revision: 1, status: "active",
          effective_from: <datetime> "${trialStart}", effective_until: <datetime> "${trialEnd}",
          active_workspace: workspace:lca08c, correlation_id: "fixture-lca08c"
        };
      `);

      const client = queryClient();
      const products = new ProductEntitlementService(
        new SurrealProductEntitlementStore(async () => client, namespace),
        () => new Date(),
      );
      const operator: ProductActor = {
        subject: "operator:carol",
        capabilities: ["subscription.manage", "quota.read"],
      };
      const synchronizer = new AiAllowancePlanCycleSynchronizer({
        workspaceSession: async (dbName) => {
          if (dbName === "ws_lca08c") return wsC;
          throw new Error(`unexpected workspace db ${dbName}`);
        },
      });
      const cascade = new SubscriptionEntitlementCascade(
        new SurrealEntitlementRefreshService(client),
        products,
        synchronizer,
      );
      const refreshC = (correlationId: string) =>
        cascade.refreshWorkspace({
          workspace: id("workspace:lca08c"),
          at: new DateTime(new Date().toISOString()),
          operationKind: "manual_assignment",
          actorKind: "operator",
          actorSubject: "operator:carol",
          authorizedCapability: "subscription.manage",
          correlationId,
          causationId: `causation:${correlationId}`,
        });
      const allowance = new AiAllowanceService({
        workspaceSession: async () => wsC,
        systemSession: async () => client,
      });
      const actor = id("user:member_c");

      // ── 1. 试用期指派：trial 周期桶落地，试用余额可预留 ──────────────────
      const rev1 = await products.publishRevision(operator, {
        planKey: "fixture_plus_c",
        displayName: "夹具律师 Plus C",
        revision: 1,
        resourceTemplateId: "quota_plan_revision:plus_v1",
        collections: [{ key: "c_core", label: "C 核心" }],
        actions: ["browse", "search", "read"],
        aiActions: ["research"],
        features: [{ key: "ai_cycle_allowance", enabled: true, limit: 200 }],
        reason: "LCA08 AC5 夹具发布",
        idempotencyKey: "lca08c-publish-1",
      });
      await products.assign(operator, {
        workspaceSlug: "lca08c",
        billingAccountKey: "lca08c",
        productPlanRevisionId: rev1.productPlanRevisionId,
        reason: "LCA08 AC5 夹具指派",
        idempotencyKey: "lca08c-assign-1",
      });
      await refreshC("lca08c-cascade-trial");
      // 独立购买加量包：试用期自带的独立有效期，不受转换影响。
      await allowance.grant({
        db: "ws_lca08c", kind: "purchased", amount: 50, label: "purchased keep",
        periodKey: `purchased:${nowMs}`, effectiveFrom: new Date(nowMs - 60_000),
        expiresAt: new Date(purchasedEnd), operatorSubject: "ops-test",
      });
      let trialBuckets = rows<{ id: unknown; period_key: string; total: number; available: number; reserved: number; expires_at: unknown; terminated_at: unknown }>(
        await wsC.query(`SELECT id, period_key, total, available, reserved, expires_at, terminated_at FROM ai_allowance_bucket WHERE kind = "plan_cycle";`).collect(),
      );
      expect(trialBuckets).toHaveLength(1);
      const trialBucketId = String(trialBuckets[0]!.id);
      expect(trialBuckets[0]!.period_key).toBe(
        `trial:quota_subscription:lca08csub:${trialStart}`,
      );
      expect(trialBuckets[0]!.terminated_at ?? null).toBeNull();

      const r1 = await allowance.reserve({
        db: "ws_lca08c", actor, channel: "interactive", actionKey: "research",
        idempotencyKey: "c-pre-1", runId: "c-run-1",
      });
      const r2 = await allowance.reserve({
        db: "ws_lca08c", actor, channel: "interactive", actionKey: "research",
        idempotencyKey: "c-pre-2", runId: "c-run-2",
      });
      expect(r1.metered && r2.metered).toBe(true);
      if (r1.metered && r2.metered) {
        expect(String(r1.reservation.bucket)).toBe(trialBucketId);
        expect(String(r2.reservation.bucket)).toBe(trialBucketId);
      }

      // ── 2. 转付费商业确认（provider 事件 trialing→active）：旧试用桶立即
      //      终止，付费周期独立新桶；并发刷新不重复发放 ───────────────────
      const coordinator = new QuotaLifecycleCoordinator(
        new SurrealQuotaLifecycleStore(client),
        cascade,
        "worker-lca08c",
      );
      await coordinator.ingestProviderEvent({
        provider: "fixture_provider",
        eventId: "evt-convert-c",
        eventType: "customer.subscription.updated",
        providerObjectId: "sub_lca08c_1",
        payloadDigest: "digest-convert-c",
        safePayload: { object_kind: "subscription" },
        signatureVerifiedAt: new DateTime(new Date().toISOString()),
        correlationId: "corr-lca08c-convert",
        snapshot: {
          billingAccount: id("billing_account:lca08c"),
          providerCustomerId: "cus_lca08c",
          providerSubscriptionId: "sub_lca08c_1",
          sourceRevision: 2,
          status: "active",
          currentPeriodStart: new DateTime(paidStart),
          currentPeriodEnd: new DateTime(paidEnd),
          cancelAtPeriodEnd: false,
        },
      });
      await expect(
        coordinator.processNextProviderEvent(),
      ).resolves.toBe("processed");
      // 紧接一次重复刷新：与转换事件同一商业终态，级联幂等收敛。
      await refreshC("lca08c-cascade-convert-concurrent");

      trialBuckets = rows(
        await wsC.query(`SELECT id, period_key, total, available, reserved, terminated_at, expires_at, created_at FROM ai_allowance_bucket WHERE kind = "plan_cycle" ORDER BY created_at;`).collect(),
      );
      expect(trialBuckets).toHaveLength(2);
      const terminatedTrial = trialBuckets.find((bucket) => String(bucket.id) === trialBucketId)!;
      const paidBucket = trialBuckets.find((bucket) => String(bucket.id) !== trialBucketId)!;
      // 终止标记落在试用桶上：金额与期限不动，不删除、不改写账本。
      expect(terminatedTrial.terminated_at != null).toBe(true);
      expect(terminatedTrial.total).toBe(200);
      expect(terminatedTrial.available).toBe(190);
      expect(terminatedTrial.reserved).toBe(10);
      expect(new Date(String(terminatedTrial.expires_at)).toISOString()).toBe(trialEnd);
      // 付费新桶独立成桶：新周期键、原授予、独立到期边界。
      expect(paidBucket.period_key).toBe(
        "subscription:quota_subscription:lca08csub:" + paidStart,
      );
      expect(paidBucket.total).toBe(200);
      expect(paidBucket.available).toBe(200);
      expect(new Date(String(paidBucket.expires_at)).toISOString()).toBe(paidEnd);

      // ── 3. 转换后新预留只能用付费桶：旧试用余额不可选（fail-closed）──────
      const r3 = await allowance.reserve({
        db: "ws_lca08c", actor, channel: "interactive", actionKey: "research",
        idempotencyKey: "c-post-1", runId: "c-run-3",
      });
      expect(r3.metered).toBe(true);
      if (r3.metered) expect(String(r3.reservation.bucket)).toBe(String(paidBucket.id));

      // ── 4. 转换前预留：deadline 内按原桶结算；取消/超时释放只冲销 ────────
      await allowance.settle({ db: "ws_lca08c", idempotencyKey: "c-pre-2" });
      await allowance.release({ db: "ws_lca08c", idempotencyKey: "c-pre-1", reason: "cancelled_before_terminal" });
      const afterRelease = rows<{ available: number; reserved: number; settled: number; terminated_at: unknown }>(
        await wsC.query(`SELECT available, reserved, settled, terminated_at FROM ONLY $bid;`, { bid: id(trialBucketId) }).collect(),
      )[0]!;
      // 释放只记冲销：available 不回升（190 = 200 − 2×5 预留，其中 5 结算、5 冲销）。
      expect(afterRelease.available).toBe(190);
      expect(afterRelease.reserved).toBe(0);
      expect(afterRelease.settled).toBe(5);
      expect(afterRelease.terminated_at != null).toBe(true);
      const writeoffs = rows<{ amount: number }>(
        await wsC.query(`SELECT amount FROM ai_ledger_entry WHERE kind = "writeoff";`).collect(),
      );
      expect(writeoffs.map((w) => w.amount)).toEqual([5]);

      // ── 5. 重复转换/刷新：不重复发放、不撤销终止、不复活试用 ────────────
      await refreshC("lca08c-cascade-convert-repeat");
      const afterRepeat = rows<{ period_key: string; total: number; terminated_at: unknown }>(
        await wsC.query(`SELECT period_key, total, terminated_at, created_at FROM ai_allowance_bucket WHERE kind = "plan_cycle" ORDER BY created_at;`).collect(),
      );
      expect(afterRepeat).toHaveLength(2);
      expect(afterRepeat.map((bucket) => bucket.total)).toEqual([200, 200]);
      expect(afterRepeat[0]!.terminated_at != null).toBe(true);
      const allGrants = rows<{ amount: number }>(
        await wsC.query(`SELECT amount, created_at FROM ai_ledger_entry WHERE kind = "grant" ORDER BY created_at;`).collect(),
      );
      expect(allGrants.map((grant) => grant.amount)).toEqual([200, 50, 200]);

      // ── 6. 余额视图：终止桶离开可消费余额，购买包独立有效期不动 ─────────
      const balance = await allowance.balance("ws_lca08c");
      expect(balance.available).toBe(245); // 付费 200−5 预留 + 购买 50
      expect(balance.reserved).toBe(5);
      expect(balance.terminated).toBe(190);
      const purchasedRow = balance.buckets.find((bucket) => bucket.kind === "purchased")!;
      expect(purchasedRow.available).toBe(50);
      expect(new Date(String(purchasedRow.expires_at)).toISOString()).toBe(purchasedEnd);
      expect(purchasedRow.terminated_at ?? null).toBeNull();

      await wsC.close();
    },
    120_000,
  );

  localTest(
    "LCA14 D3: different trial/paid source IDs terminate only the linked trial through the operator lifecycle",
    async () => {
      // 真正的显式试用 claim + workspace creator + 原生配额供应；隔离本地公司 fork。
      // 此用例聚焦额度交付，IdP 换票与内容投影不作为本用例验收对象。
      const otherWorkspaceBefore = rows(await workspaceDb!.query("SELECT id,total,available,reserved,settled,terminated_at FROM ai_allowance_bucket ORDER BY id").collect());
      let wsC: Surreal;
      let workspaceId: string;
      let trialStart: string;
      let trialEnd: string;
      const nowMs = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      let paidStart: string;
      const paidEnd = iso(nowMs + 30 * 86_400_000);
      const purchasedEnd = iso(nowMs + 90 * 86_400_000);
      await db!.query(`IF (SELECT * FROM ONLY platform_operator:carol) = NONE {
          CREATE platform_operator:carol CONTENT { subject:"operator:carol",display_name:"Carol",status:"active" };
          CREATE platform_operator_capability:carol_sub CONTENT { operator:platform_operator:carol,
            capability:"subscription.manage",status:"active",granted_by_subject:"test" };
        };
        CREATE billing_account:lca14newsource CONTENT {
        account_key:"lca14newsource",name:"LCA14 isolated",kind:"team",status:"active" };
        CREATE billing_account_member CONTENT { billing_account:billing_account:lca14newsource,
          subject:"operator:carol",role:"owner",status:"active" };
        CREATE pro_trial_eligibility CONTENT { billing_account:billing_account:lca14newsource,
          enabled:true,reason:"合成不可售夹具",approved_by:"test" };`);

      const client = queryClient();
      const products = new ProductEntitlementService(
        new SurrealProductEntitlementStore(async () => client, namespace),
        () => new Date(),
      );
      const operator: ProductActor = {
        subject: "operator:carol",
        capabilities: ["subscription.manage", "quota.read"],
      };
      const synchronizer = new AiAllowancePlanCycleSynchronizer({
        workspaceSession: async (dbName) => {
          if (dbName === "ws_lca14newsource") return wsC;
          throw new Error(`unexpected workspace db ${dbName}`);
        },
      });
      const cascade = new SubscriptionEntitlementCascade(
        new SurrealEntitlementRefreshService(client),
        products,
        synchronizer,
      );
      const refreshC = (correlationId: string) =>
        cascade.refreshWorkspace({
          workspace: id(workspaceId),
          at: new DateTime(new Date().toISOString()),
          operationKind: "manual_assignment",
          actorKind: "operator",
          actorSubject: "operator:carol",
          authorizedCapability: "subscription.manage",
          correlationId,
          causationId: `causation:${correlationId}`,
        });
      const allowance = new AiAllowanceService({
        workspaceSession: async () => wsC,
        systemSession: async () => client,
      });
      let actor: StringRecordId;

      // ── 1. 试用期指派：trial 周期桶落地，试用余额可预留 ──────────────────
      const rev1 = await products.publishRevision(operator, {
        planKey: "fixture_plus_new",
        displayName: "夹具律师 Plus C",
        revision: 1,
        resourceTemplateId: "quota_plan_revision:trial_v1",
        collections: [{ key: "new_core", label: "C 核心" }],
        actions: ["browse", "search", "read", "cite"],
        aiActions: ["research"],
        features: [{ key: "ai_cycle_allowance", enabled: true, limit: 200 }],
        reason: "LCA08 AC5 夹具发布",
        idempotencyKey: "lca14newsource-publish-1",
      });
      await db!.query(`CREATE pro_trial_revision:lca14 CONTENT { product_revision:$product,
        duration_days:7,research_rate:5,rate_revision:2,reminder_hours:[24],fixture:true,
        approved_by:"test",approval_reason:"合成不可售夹具" };
        UPSERT pro_trial_configuration:current CONTENT { revision:pro_trial_revision:lca14,
          enabled:true,updated_by:"test" };`, { product: id(rev1.productPlanRevisionId) });
      const creator = createWorkspaceCreator({ namespace, generateId: () => "lca14newsource",
        getDbSession: async name => {
          if (name === "_system") return client;
          if (!wsC) wsC = await connect(name);
          return wsC;
        },
        // 额度侧最小真实模板；内容/OIDC 不在本用例的验收范围。
        loadTemplateScripts: async () => await Promise.all(
          ["035-ai-allowance.surql", "042-ai-plan-upgrade-proration.surql", "047-ai-source-termination.surql"].map(async file => ({
            version: Number(file.slice(0, 3)), name: file,
            sql: await readFile(new URL(`../../../shared/sql/workspace-template/${file}`, import.meta.url), "utf8"),
          }))),
        loadTemplatePackScripts: async () => [],
        idpTokenScopeAdapter: { updateUserScope: async () => ({ accessToken:"local-fixture-only",expiresIn:60 }) },
        deliverTrial: async input => {
          workspaceId = input.workspaceId;
          trialStart = input.trial.startsAt;
          trialEnd = input.trial.endsAt;
          const result = await products.refreshSubscriptionDriven(workspaceId, { correlationId: input.trial.claimId });
          expect(result.planCycle?.baseSourceKind).toBe("trial");
          await synchronizer.sync(result.planCycle!, input.trial.claimId);
        },
      });
      const trial = new ProTrialService(new SurrealTrialStore(async () => client), creator);
      const request = { subject:"operator:carol",subjectToken:"local-fixture-only",email:"lca14@local.test",
        accountKey:"lca14newsource",name:"LCA14",slug:"lca14newsource",key:"start",
        offerRevision:"pro_trial_revision:lca14" };
      await expect(trial.start(request)).resolves.toMatchObject({ state:"active",slug:"lca14newsource" });
      await expect(trial.start(request)).resolves.toMatchObject({ state:"active",slug:"lca14newsource" });
      actor = id(String(rows(await wsC!.query("SELECT id FROM user WHERE subject='operator:carol'").collect())[0]!.id));
      expect(rows(await db!.query("SELECT * FROM pro_trial_claim WHERE slug='lca14newsource'").collect())).toHaveLength(1);
      // 独立购买加量包：试用期自带的独立有效期，不受转换影响。
      await allowance.grant({
        db: "ws_lca14newsource", kind: "purchased", amount: 50, label: "purchased keep",
        periodKey: `purchased:${nowMs}`, effectiveFrom: new Date(nowMs - 60_000),
        expiresAt: new Date(purchasedEnd), operatorSubject: "ops-test",
      });
      let trialBuckets = rows<{ id: unknown; period_key: string; total: number; available: number; reserved: number; expires_at: unknown; terminated_at: unknown }>(
        await wsC.query(`SELECT id, period_key, total, available, reserved, expires_at, terminated_at FROM ai_allowance_bucket WHERE kind = "plan_cycle";`).collect(),
      );
      expect(trialBuckets).toHaveLength(1);
      const trialBucketId = String(trialBuckets[0]!.id);
      expect(trialBuckets[0]!.period_key).toBe(
        `trial:quota_subscription:provision_ws_lca14newsource:${trialStart}`,
      );
      expect(trialBuckets[0]!.terminated_at ?? null).toBeNull();

      const r1 = await allowance.reserve({
        db: "ws_lca14newsource", actor, channel: "interactive", actionKey: "research",
        idempotencyKey: "c-pre-1", runId: "c-run-1",
      });
      const r2 = await allowance.reserve({
        db: "ws_lca14newsource", actor, channel: "interactive", actionKey: "research",
        idempotencyKey: "c-pre-2", runId: "c-run-2",
      });
      expect(r1.metered && r2.metered).toBe(true);
      if (r1.metered && r2.metered) {
        expect(String(r1.reservation.bucket)).toBe(trialBucketId);
        expect(String(r2.reservation.bucket)).toBe(trialBucketId);
      }

      // ── 2. 运营确认转换（trialing→active，新商业来源）：旧试用桶立即
      //      终止，付费周期独立新桶；并发刷新不重复发放 ───────────────────
      paidStart = iso(Date.now());
      const coordinator = new QuotaLifecycleCoordinator(
        new SurrealQuotaLifecycleStore(client),
        cascade,
        "worker-lca14newsource",
      );
      await coordinator.submitOperatorIntent({
        kind: "subscription_upsert", actorSubject: "operator:carol", actorCapability: "subscription.manage",
        requestId: "convert-new-source", workspace: id(workspaceId), billingAccount: id("billing_account:lca14newsource"),
        customerReason: "隔离夹具转换", operatorReason: "LCA14 不触发商业付款", effectiveAt: new DateTime(paidStart),
        input: { mode: "manual_assignment", source: "manual", subscription: "quota_subscription:lca14paid",
          plan_revision: "quota_plan_revision:plus_v1", status: "active",
          current_period_start: paidStart, current_period_end: paidEnd },
        impactPreview: { fixture: true }, correlationId: "corr-new-source-convert",
      });
      await expect(coordinator.processNextOperatorIntent()).resolves.toBe("processed");
      // 紧接一次重复刷新：与转换事件同一商业终态，级联幂等收敛。
      await Promise.all([refreshC("lca14newsource-cascade-convert-concurrent-1"), refreshC("lca14newsource-cascade-convert-concurrent-2")]);

      trialBuckets = rows(
        await wsC.query(`SELECT id, period_key, total, available, reserved, terminated_at, expires_at, created_at FROM ai_allowance_bucket WHERE kind = "plan_cycle" ORDER BY created_at;`).collect(),
      );
      expect(trialBuckets).toHaveLength(2);
      const terminatedTrial = trialBuckets.find((bucket) => String(bucket.id) === trialBucketId)!;
      const paidBucket = trialBuckets.find((bucket) => String(bucket.id) !== trialBucketId)!;
      // 终止标记落在试用桶上：金额与期限不动，不删除、不改写账本。
      expect(terminatedTrial.terminated_at != null).toBe(true);
      expect(terminatedTrial.total).toBe(200);
      expect(terminatedTrial.available).toBe(190);
      expect(terminatedTrial.reserved).toBe(10);
      expect(new Date(String(terminatedTrial.expires_at)).toISOString()).toBe(trialEnd);
      // 付费新桶独立成桶：新周期键、原授予、独立到期边界。
      expect(paidBucket.period_key).toBe(
        "subscription:quota_subscription:lca14paid:" + paidStart,
      );
      expect(paidBucket.total).toBe(200);
      expect(paidBucket.available).toBe(200);
      expect(new Date(String(paidBucket.expires_at)).toISOString()).toBe(paidEnd);

      // ── 3. 转换后新预留只能用付费桶：旧试用余额不可选（fail-closed）──────
      const r3 = await allowance.reserve({
        db: "ws_lca14newsource", actor, channel: "interactive", actionKey: "research",
        idempotencyKey: "c-post-1", runId: "c-run-3",
      });
      expect(r3.metered).toBe(true);
      if (r3.metered) expect(String(r3.reservation.bucket)).toBe(String(paidBucket.id));

      // ── 4. 转换前预留：deadline 内按原桶结算；取消/超时释放只冲销 ────────
      await allowance.settle({ db: "ws_lca14newsource", idempotencyKey: "c-pre-2" });
      await allowance.release({ db: "ws_lca14newsource", idempotencyKey: "c-pre-1", reason: "cancelled_before_terminal" });
      const afterRelease = rows<{ available: number; reserved: number; settled: number; terminated_at: unknown }>(
        await wsC.query(`SELECT available, reserved, settled, terminated_at FROM ONLY $bid;`, { bid: id(trialBucketId) }).collect(),
      )[0]!;
      // 释放只记冲销：available 不回升（190 = 200 − 2×5 预留，其中 5 结算、5 冲销）。
      expect(afterRelease.available).toBe(190);
      expect(afterRelease.reserved).toBe(0);
      expect(afterRelease.settled).toBe(5);
      expect(afterRelease.terminated_at != null).toBe(true);
      const writeoffs = rows<{ amount: number }>(
        await wsC.query(`SELECT amount FROM ai_ledger_entry WHERE kind = "writeoff";`).collect(),
      );
      expect(writeoffs.map((w) => w.amount)).toEqual([5]);

      // ── 5. 重复转换/刷新：不重复发放、不撤销终止、不复活试用 ────────────
      await refreshC("lca14newsource-cascade-convert-repeat");
      const afterRepeat = rows<{ period_key: string; total: number; terminated_at: unknown }>(
        await wsC.query(`SELECT period_key, total, terminated_at, created_at FROM ai_allowance_bucket WHERE kind = "plan_cycle" ORDER BY created_at;`).collect(),
      );
      expect(afterRepeat).toHaveLength(2);
      expect(afterRepeat.map((bucket) => bucket.total)).toEqual([200, 200]);
      expect(afterRepeat[0]!.terminated_at != null).toBe(true);
      const allGrants = rows<{ amount: number }>(
        await wsC.query(`SELECT amount, created_at FROM ai_ledger_entry WHERE kind = "grant" ORDER BY created_at;`).collect(),
      );
      expect(allGrants.map((grant) => grant.amount)).toEqual([200, 50, 200]);

      // ── 6. 余额视图：终止桶离开可消费余额，购买包独立有效期不动 ─────────
      const balance = await allowance.balance("ws_lca14newsource");
      expect(balance.available).toBe(245); // 付费 200−5 预留 + 购买 50
      expect(balance.reserved).toBe(5);
      expect(balance.terminated).toBe(190);
      const purchasedRow = balance.buckets.find((bucket) => bucket.kind === "purchased")!;
      expect(purchasedRow.available).toBe(50);
      expect(new Date(String(purchasedRow.expires_at)).toISOString()).toBe(purchasedEnd);
      expect(purchasedRow.terminated_at ?? null).toBeNull();

      const markers = rows(await wsC.query("SELECT source_prefix,paid_source,event_key FROM ai_allowance_source_termination").collect());
      expect(markers).toHaveLength(1);
      expect(markers[0]!.source_prefix).toBe("trial:quota_subscription:provision_ws_lca14newsource:");
      expect(markers[0]!.paid_source).toBe("quota_subscription:lca14paid");
      await wsC.query(`CREATE ai_allowance_bucket:late_trial CONTENT {
        kind:"plan_cycle", label:"迟到试用", period_key:$latePeriod, total:10,available:10,reserved:0,settled:0,
        effective_from:$from,expires_at:$until };
        CREATE ai_allowance_bucket:unrelated_trial CONTENT {
        kind:"plan_cycle", label:"其他来源", period_key:"trial:quota_subscription:other:cycle", total:12,available:12,reserved:0,settled:0,
        effective_from:$from,expires_at:$until };`, {
        latePeriod: `trial:quota_subscription:provision_ws_lca14newsource:${trialStart}:late`,
        from: new DateTime(trialStart), until: new DateTime(trialEnd),
      }).collect();
      const late = rows(await wsC.query("SELECT terminated_at FROM ai_allowance_bucket:late_trial").collect())[0]!;
      const unrelated = rows(await wsC.query("SELECT terminated_at FROM ai_allowance_bucket:unrelated_trial").collect())[0]!;
      expect(late.terminated_at != null).toBe(true);
      expect(unrelated.terminated_at ?? null).toBeNull();
      // 等值 28 点不能绕过有效窗口/status/终止/来源门禁；购买、补偿独立。
      const from = new DateTime(iso(Date.now() - 60000));
      const until = new DateTime(purchasedEnd);
      for (const spec of [
        { key:"stale28",kind:"plan_cycle",period:"trial:legacy:cycle" },
        { key:"future28",kind:"purchased",period:"future",from:new DateTime(iso(Date.now()+86400000)) },
        { key:"expired28",kind:"purchased",period:"expired",from:new DateTime(iso(Date.now()-86400000)),until:new DateTime(iso(Date.now()-1000)) },
        { key:"suspended28",kind:"purchased",period:"suspended",status:"suspended" },
        { key:"terminated28",kind:"purchased",period:"terminated",terminated:from },
        { key:"compensation28",kind:"compensation",period:"compensation" },
      ]) {
        await wsC.query(`CREATE $bucket CONTENT { kind:$kind,label:$label,period_key:$period,
          total:28,available:28,reserved:0,settled:0,status:$status,effective_from:$from,expires_at:$until,
          terminated_at:$terminated };`, { bucket:id(`ai_allowance_bucket:${spec.key}`),kind:spec.kind,label:spec.key,
          period:spec.period,status:"status" in spec ? spec.status : "active",from:"from" in spec ? spec.from : from,
          until:"until" in spec ? spec.until : until,terminated:"terminated" in spec ? spec.terminated : undefined }).collect();
      }
      const planPrefix = "subscription:quota_subscription:lca14paid:";
      const consumable = rows(await wsC.query(`SELECT id FROM ai_allowance_bucket WHERE ${AI_ALLOWANCE_CONSUMABLE_SQL}`, { planPrefix }).collect()).map(r=>String(r.id)).sort();
      const all = rows(await wsC.query("SELECT * FROM ai_allowance_bucket").collect());
      const classified = all.filter(r=>aiAllowanceConsumptionReason({kind:String(r.kind),period_key:String(r.period_key),
        status:String(r.status),effective_from:String(r.effective_from),expires_at:String(r.expires_at),terminated_at:r.terminated_at},planPrefix)==="available").map(r=>String(r.id)).sort();
      expect(consumable).toEqual(classified);
      expect(consumable).toHaveLength(3); // current paid + purchased + compensation
      const matrixBalance = await allowance.balance("ws_lca14newsource");
      expect(matrixBalance.available).toBe(273);
      expect(matrixBalance.pending).toBe(28);
      expect(matrixBalance.suspended).toBe(28);
      expect(matrixBalance.expired).toBe(28);
      expect(matrixBalance.terminated).toBe(268); // original190 + late10 + unrelated12 + stale28 + explicit28
      expect(rows(await workspaceDb!.query("SELECT id,total,available,reserved,settled,terminated_at FROM ai_allowance_bucket ORDER BY id").collect())).toEqual(otherWorkspaceBefore);
      await wsC.close();
    },
    120_000,
  );

  localTest(
    "operator renewal extends the active item window and replay conflict maps to an idempotency-conflict code",
    async () => {
      // QA 退回缺陷回归：运营路径同套餐同产品续费（$same 分支）必须随
      // 订阅付费窗口向前延长活跃 item 的 effective_until——否则周期前移
      // 后权益按旧窗口到期，付费周期内误落 retention。provider 快照路径
      // 已有同语义（本文件上一用例第 3 段），本用例覆盖运营入口。
      await db!.query(`DEFINE DATABASE IF NOT EXISTS ws_lca08d;`);
      const wsD = await connect("ws_lca08d");
      for (const script of ["035-ai-allowance.surql", "042-ai-plan-upgrade-proration.surql", "047-ai-source-termination.surql"]) {
        await wsD.query(
          await readFile(
            new URL(`../../../shared/sql/workspace-template/${script}`, import.meta.url),
            "utf8",
          ),
        );
      }
      await db!.query(`
        CREATE billing_account:lca08d CONTENT {
          account_key: "lca08d",
          name: "LCA08D Billing",
          kind: "team",
          status: "active"
        };
        CREATE workspace:lca08d CONTENT {
          db_name: "ws_lca08d",
          owner_subject: "operator:dana",
          slug: "lca08d",
          name: "LCA08D",
          status: "active"
        };
        CREATE platform_operator:dana CONTENT {
          subject: "operator:dana",
          display_name: "Dana",
          status: "active"
        };
        CREATE platform_operator_capability:dana_subscription CONTENT {
          operator: platform_operator:dana,
          capability: "subscription.manage",
          status: "active",
          granted_by_subject: "system:test"
        };
        CREATE quota_subscription:lca08dsub CONTENT {
          billing_account: billing_account:lca08d,
          source: "manual",
          status: "active",
          revision: 1,
          current_period_start: <datetime> "2026-10-01T00:00:00.000Z",
          current_period_end: <datetime> "2026-11-01T00:00:00.000Z",
          paid_through: <datetime> "2026-11-01T00:00:00.000Z",
          cancel_at_period_end: false,
          correlation_id: "fixture-lca08d"
        };
        CREATE quota_subscription_item:lca08ditem CONTENT {
          subscription: quota_subscription:lca08dsub,
          workspace: workspace:lca08d,
          plan_revision: quota_plan_revision:plus_v1,
          revision: 1,
          status: "active",
          effective_from: <datetime> "2026-10-01T00:00:00.000Z",
          effective_until: <datetime> "2026-11-01T00:00:00.000Z",
          active_workspace: workspace:lca08d,
          correlation_id: "fixture-lca08d"
        };
      `);

      const client = queryClient();
      const cascade = new SubscriptionEntitlementCascade(
        new SurrealEntitlementRefreshService(client),
        new ProductEntitlementService(
          new SurrealProductEntitlementStore(async () => client, namespace),
          () => new Date("2026-10-15T00:00:00.000Z"),
        ),
        new AiAllowancePlanCycleSynchronizer({
          workspaceSession: async () => wsD,
        }),
      );
      const lifecycleNow = new DateTime("2026-10-15T00:00:00.000Z");
      const coordinator = new QuotaLifecycleCoordinator(
        new SurrealQuotaLifecycleStore(client),
        cascade,
        "worker-lca08d",
        undefined,
        { clock: { now: () => lifecycleNow } },
      );

      // ── 1. 运营续费：同订阅同套餐，周期与 paid_through 前移 ────────────
      const renewalSubmission = {
        kind: "subscription_upsert" as const,
        actorSubject: "operator:dana",
        actorCapability: "subscription.manage" as const,
        requestId: "lca08d-renew-1",
        workspace: id("workspace:lca08d"),
        billingAccount: id("billing_account:lca08d"),
        customerReason: "客户续费下一个周期",
        operatorReason: "LCA08 运营续费回归",
        effectiveAt: lifecycleNow,
        input: {
          mode: "manual_assignment",
          workspace: id("workspace:lca08d"),
          billing_account: id("billing_account:lca08d"),
          subscription: id("quota_subscription:lca08dsub"),
          plan_revision: id("quota_plan_revision:plus_v1"),
          source: "manual",
          status: "active",
          current_period_start: new DateTime("2026-11-01T00:00:00.000Z"),
          current_period_end: new DateTime("2026-12-01T00:00:00.000Z"),
          paid_through: new DateTime("2026-12-01T00:00:00.000Z"),
        },
        correlationId: "corr-lca08d-renew-1",
      };
      await expect(
        coordinator.submitOperatorIntent(renewalSubmission),
      ).resolves.toMatchObject({ kind: "accepted" });
      await expect(
        coordinator.processNextOperatorIntent(),
      ).resolves.toBe("processed");

      // 续费后：仍是同一个活跃 item（不新建），窗口向前延长到 12/1。
      const renewedItems = rows(
        await db!.query(
          `SELECT id, status, effective_from, effective_until
           FROM quota_subscription_item
           WHERE workspace = workspace:lca08d;`,
        ),
      );
      expect(renewedItems).toHaveLength(1);
      expect(renewedItems[0]).toMatchObject({
        id: "quota_subscription_item:lca08ditem",
        status: "active",
      });
      expect(new Date(String(renewedItems[0]!.effective_from)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(new Date(String(renewedItems[0]!.effective_until)).toISOString()).toBe(
        "2026-12-01T00:00:00.000Z",
      );
      const renewedSub = rows(
        await db!.query(
          `SELECT current_period_end, paid_through FROM ONLY quota_subscription:lca08dsub;`,
        ),
      )[0];
      expect(new Date(String(renewedSub!.current_period_end)).toISOString()).toBe(
        "2026-12-01T00:00:00.000Z",
      );

      // ── 2. 只延不缩：用更早窗口再提交同 plan upsert，窗口不回退 ────────
      await coordinator.submitOperatorIntent({
        ...renewalSubmission,
        requestId: "lca08d-renew-shrink",
        correlationId: "corr-lca08d-renew-shrink",
        input: {
          ...renewalSubmission.input,
          current_period_start: new DateTime("2026-11-01T00:00:00.000Z"),
          current_period_end: new DateTime("2026-11-15T00:00:00.000Z"),
          paid_through: new DateTime("2026-11-15T00:00:00.000Z"),
        },
      });
      await expect(
        coordinator.processNextOperatorIntent(),
      ).resolves.toBe("processed");
      const afterShrink = rows(
        await db!.query(
          `SELECT effective_until FROM ONLY quota_subscription_item:lca08ditem;`,
        ),
      )[0];
      expect(new Date(String(afterShrink!.effective_until)).toISOString()).toBe(
        "2026-12-01T00:00:00.000Z",
      );

      // ── 3. 幂等语义：同 requestId 同载荷 → duplicate；改载荷 → ─────────
      //      operator_intent_idempotency_conflict（路由映射 409，不再 500）
      await expect(
        coordinator.submitOperatorIntent(renewalSubmission),
      ).resolves.toMatchObject({ kind: "duplicate" });
      try {
        await coordinator.submitOperatorIntent({
          ...renewalSubmission,
          customerReason: "同一 requestId 改了载荷",
        });
        expect.unreachable("conflicting payload must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(QuotaLifecycleError);
        expect((error as QuotaLifecycleError).code).toBe(
          "operator_intent_idempotency_conflict",
        );
        expect((error as QuotaLifecycleError).retryable).toBe(false);
      }

      await wsD.close();
    },
    120_000,
  );
});
