import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { handleError } from "../middleware/error";
import { EntitlementRecoveryStore, fixtureAssignment, fixtureGrantBody, fixtureRevision, seedWorkspace } from "../../test/entitlement-recovery-store";
import { ProductEntitlementService } from "../product-entitlement/service";
import { createProductEntitlementRoutes } from "./product-entitlement";

const ALL_CAPS: PlatformOperatorCapability[] = ["quota.read", "subscription.manage", "entitlement.gift", "entitlement.repair"];

/**
 * 运营身份桩：与 requirePlatformOperator 同一契约——每次请求重新核能力集合，
 * 能力被撤销后立即 403（等价生产路径的每请求重查 + token introspection）。
 */
function operatorHarness() {
  const liveCaps = new Set<string>(ALL_CAPS);
  const requireOperator = (capability?: PlatformOperatorCapability): MiddlewareHandler<AppBindings> => async (c, next) => {
    if (capability && !liveCaps.has(capability)) {
      throw new HttpError(403, "platform-operator-capability", "缺少所需平台运营能力");
    }
    c.set("platformOperator", { subject: "ops", capabilities: [...liveCaps] as PlatformOperatorCapability[] });
    await next();
  };
  return { liveCaps, requireOperator };
}

const requireCustomer: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", { subject: "lawyer", email: "lawyer@example.test", raw: {}, rawToken: "token" });
  await next();
};

function buildApp(store: EntitlementRecoveryStore, now: Date = new Date("2026-09-24T00:00:00.000Z")) {
  const harness = operatorHarness();
  const service = new ProductEntitlementService(store, () => now);
  const app = new Hono<AppBindings>()
    .route("/", createProductEntitlementRoutes({ service, requireCustomer: () => requireCustomer, requireOperator: harness.requireOperator }))
    .onError(handleError);
  return { app, harness, service };
}

function seed(store: EntitlementRecoveryStore) {
  seedWorkspace(store);
  store.revisions.set("product_plan_revision:fixture:1", fixtureRevision());
}

const post = (app: Hono<AppBindings>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("LCA13 运营端 API 闭环（路由级）", () => {
  test("交付失败修复闭环：视图 → 预览（零写入）→ 确认修复 → 快照推进、指针回指", async () => {
    const store = new EntitlementRecoveryStore();
    seed(store);
    const { app, service } = buildApp(store);
    await service.assign({ subject: "ops", capabilities: ALL_CAPS }, fixtureAssignment("product_plan_revision:fixture:1"));

    // 运营先看工作区权益视图（quota.read）。
    const view = await (await app.request("/api/ops/product-entitlements/workspaces/team")).json();
    expect(view.workspaceSlug).toBe("team");

    // 预览：指针损坏场景，零写入。
    store.pointer.set("workspace:team", "workspace_product_entitlement:missing");
    const previewRes = await app.request("/api/ops/product-entitlements/workspaces/team/delivery-preview");
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.boundRevisionId).toBe("product_plan_revision:fixture:1");
    expect(preview.current.revision).toBe(0); // 指针损坏如实呈现，不修复
    expect(store.pointer.get("workspace:team")).toBe("workspace_product_entitlement:missing");

    // 确认修复：带回预览看到的当前修订（损坏指针场景没有已交付快照，传 null）。
    const repairRes = await post(app, "/api/ops/product-entitlements/workspaces/team/delivery-repair", {
      reason: "投影未交付，重试", idempotencyKey: "repair-route-0001", expectedCurrentRevision: null,
    });
    expect(repairRes.status).toBe(200);
    const repaired = await repairRes.json();
    expect(repaired.changed).toBe(true);
    expect(repaired.after.content.collections.map((item: { key: string }) => item.key)).toEqual(["fixture_core"]);
    expect(store.pointer.get("workspace:team")).toBe(store.snapshots[0]!.id);

    // 客户视角同步更新：核验后客户能看到同一权益状态。
    const customer = await (await app.request("/api/workspaces/team/product-entitlement")).json();
    expect(customer.content.projection).toBeNull(); // 客户视图不暴露运营核验
    expect(customer.content.collections.map((item: { key: string }) => item.key)).toEqual(["fixture_core"]);
  });

  test("重叠赠送授予/撤销/到期闭环；撤销只影响赠送来源", async () => {
    const store = new EntitlementRecoveryStore();
    seed(store);
    const { app, service } = buildApp(store);
    await service.assign({ subject: "ops", capabilities: ALL_CAPS }, fixtureAssignment("product_plan_revision:fixture:1"));

    // 授予（与基础订阅重叠的赠送来源）。
    const grantRes = await post(app, "/api/ops/product-entitlements/grants", fixtureGrantBody());
    expect(grantRes.status).toBe(200);
    const granted = await grantRes.json();
    expect(granted.content.sources.map((item: { kind: string }) => item.kind)).toEqual(["base", "grant"]);

    // 撤销：只移除赠送来源，基础订阅授权保留。
    const grantId = store.grantRows[0]!.id;
    const revokeRes = await post(app, "/api/ops/product-entitlements/grants/revoke", {
      workspaceSlug: "team", grantId, reason: "赠送回收", idempotencyKey: "gift-revoke-route-1",
    });
    expect(revokeRes.status).toBe(200);
    const revoked = await revokeRes.json();
    expect(revoked.after.content.sources.map((item: { kind: string }) => item.kind)).toEqual(["base"]);

    // 到期：新赠送窗口已过，自动失效且不动快照指针。
    const expired = await post(app, "/api/ops/product-entitlements/grants", fixtureGrantBody({
      effectiveUntil: "2026-09-20T00:00:00.000Z", idempotencyKey: "gift-team-expired",
    }));
    expect(expired.status).toBe(200);
    const expiredView = await expired.json();
    expect(expiredView.content.sources.map((item: { kind: string }) => item.kind)).toEqual(["base"]);
  });

  test("运营资格失效即 403：能力逐请求重查，失格后旧请求不能继续执行动作", async () => {
    const store = new EntitlementRecoveryStore();
    seed(store);
    const { app, harness } = buildApp(store);

    expect((await post(app, "/api/ops/product-entitlements/grants", fixtureGrantBody({ idempotencyKey: "gift-cap-1" }))).status).toBe(200);
    // 撤销 gift 能力后，同一 token 立即不能再发放/撤销赠送。
    harness.liveCaps.delete("entitlement.gift");
    expect((await post(app, "/api/ops/product-entitlements/grants", fixtureGrantBody({ idempotencyKey: "gift-cap-2" }))).status).toBe(403);
    expect((await post(app, "/api/ops/product-entitlements/grants/revoke", {
      workspaceSlug: "team", grantId: store.grantRows[0]!.id, reason: "x", idempotencyKey: "gift-rev-cap",
    })).status).toBe(403);
    // repair 能力独立：只有 entitlement.gift 时不能修复。
    harness.liveCaps.delete("entitlement.repair");
    expect((await post(app, "/api/ops/product-entitlements/workspaces/team/delivery-repair", {
      reason: "x", idempotencyKey: "repair-cap-1", expectedCurrentRevision: null,
    })).status).toBe(403);
    // 连 quota.read 都失去后，连查看都不行。
    harness.liveCaps.delete("quota.read");
    expect((await app.request("/api/ops/product-entitlements/workspaces/team")).status).toBe(403);
    // 状态未被失格请求污染。
    expect(store.revocations).toHaveLength(0);
  });

  test("并发与重复请求：同键并发收敛同结果；旧修订护栏返回 409 且不写入", async () => {
    const store = new EntitlementRecoveryStore();
    seed(store);
    const { app, service } = buildApp(store);
    await service.assign({ subject: "ops", capabilities: ALL_CAPS }, fixtureAssignment("product_plan_revision:fixture:1"));
    const auditsBefore = store.audits.length;

    // 同幂等键并发提交（UI 双击/重试场景）：收敛，不重复执行。
    const [a, b] = await Promise.all([
      post(app, "/api/ops/product-entitlements/workspaces/team/delivery-repair", {
        reason: "并发重试", idempotencyKey: "repair-conc-1", expectedCurrentRevision: 1,
      }),
      post(app, "/api/ops/product-entitlements/workspaces/team/delivery-repair", {
        reason: "并发重试", idempotencyKey: "repair-conc-1", expectedCurrentRevision: 1,
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(store.audits.filter((row) => row.action === "repair")).toHaveLength(1);

    // 旧修订护栏：声明 expectedCurrentRevision 已过期 → 409 且零写入。
    const conflict = await post(app, "/api/ops/product-entitlements/workspaces/team/delivery-repair", {
      reason: "旧视图", idempotencyKey: "repair-conc-2", expectedCurrentRevision: 0,
    });
    expect(conflict.status).toBe(409);
    expect(store.snapshots).toHaveLength(1);
    expect(store.audits.length).toBe(auditsBefore + 1);
  });

  test("服务重启后同一幂等键重放同一结果", async () => {
    const store = new EntitlementRecoveryStore();
    seed(store);
    const first = buildApp(store);
    await first.service.assign({ subject: "ops", capabilities: ALL_CAPS }, fixtureAssignment("product_plan_revision:fixture:1"));
    const grantRes = await post(first.app, "/api/ops/product-entitlements/grants", fixtureGrantBody());
    expect(grantRes.status).toBe(200);

    // 进程重启：新实例挂载同一存储。
    const restarted = buildApp(store);
    const replay = await post(restarted.app, "/api/ops/product-entitlements/grants", fixtureGrantBody());
    expect(replay.status).toBe(200);
    const replayed = await replay.json();
    expect(store.grantRows).toHaveLength(1); // 幂等键收敛，不产生第二条赠送
    expect(replayed.content.sources.map((item: { kind: string }) => item.kind)).toEqual(["base", "grant"]);
  });
});
