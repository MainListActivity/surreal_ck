import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, jsonify, StringRecordId, Surreal } from "surrealdb";
import { AiAllowancePlanCycleSynchronizer } from "../ai-allowance/plan-cycle";
import { ProductEntitlementService, type ProductActor } from "../product-entitlement/service";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { seedQuotaPlans } from "../db/quota-plan-seed";
import { SurrealEntitlementRefreshService } from "./entitlement-refresh";
import { QuotaLifecycleCoordinator } from "./subscription-lifecycle";
import { SubscriptionEntitlementCascade } from "./subscription-cascade";
import { SurrealQuotaLifecycleStore } from "./lifecycle-store";

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
  await workspaceDb.query(
    await readFile(
      new URL("../../../shared/sql/workspace-template/035-ai-allowance.surql", import.meta.url),
      "utf8",
    ),
  );

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

      // ── 3. 周期内升级：只补发正差额，桶到期边界不变，重复刷新不重复补 ────
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
          `SELECT total, available, expires_at FROM ai_allowance_bucket;`,
        ),
      );
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({ total: 350, available: 350 });
      expect(new Date(String(buckets[0]!.expires_at)).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
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
          `SELECT total, available FROM ai_allowance_bucket;`,
        ),
      );
      expect(buckets[0]).toMatchObject({ total: 350, available: 350 });
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
          `SELECT total, available, expires_at FROM ai_allowance_bucket;`,
        ),
      );
      expect(buckets[0]).toMatchObject({ total: 350, available: 350 });
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
          `SELECT kind, period_key, total, available, expires_at
           FROM ai_allowance_bucket ORDER BY period_key;`,
        ),
      );
      expect(buckets).toHaveLength(2);
      const previousPeriod = buckets.find((bucket) =>
        String(bucket.period_key).includes("quota_subscription:lca08sub:2026-09-01"),
      );
      const renewedPeriod = buckets.find((bucket) =>
        String(bucket.period_key).includes("quota_subscription:lca08sub2:2026-09-20"),
      );
      expect(previousPeriod).toMatchObject({ total: 350, available: 350 });
      expect(new Date(String(previousPeriod!.expires_at)).toISOString()).toBe(
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
      expect(finalBuckets).toHaveLength(2);
    },
    120_000,
  );
});
