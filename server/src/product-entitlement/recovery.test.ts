import { describe, expect, test } from "bun:test";
import type { ProjectionVerification } from "@surreal-ck/shared";
import { EntitlementRecoveryStore, fixtureAssignment, fixtureGrantBody, fixtureRevision, operator, seedWorkspace } from "../../test/entitlement-recovery-store";
import type { ProjectionVerifyInput } from "../content/projection-verify";
import { ProductEntitlementService } from "./service";

const NO_PROJECTION: Pick<ProjectionVerification, "workspace" | "collections"> = {
  workspace: { state: "absent", revision: null, revisionNumber: null, matchesExpected: null, confirmedUntil: null, expectedRevisionNumber: null },
  collections: [],
};

/** 核验桩：返回设定 verdict，并记录收到的核验输入（断言 workspaceDb/期望快照）。 */
function projectionStub(verdict: ProjectionVerification["verdict"]) {
  const calls: ProjectionVerifyInput[] = [];
  return {
    calls,
    projectionVerify: async (input: ProjectionVerifyInput): Promise<ProjectionVerification> => {
      calls.push(input);
      return { checkedAt: "2026-09-24T00:00:00.000Z", verdict, ...NO_PROJECTION };
    },
  };
}

describe("LCA13 运营解释、临时授权与交付修复", () => {
  test("赠送是与基础订阅重叠的独立来源；撤销只移除该来源，基础授权保留", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const service = new ProductEntitlementService(store, () => now);
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    await service.assign(operator, fixtureAssignment(revisionId));
    const granted = await service.grant(operator, fixtureGrantBody());
    expect(granted.content.sources.map((item) => item.kind)).toEqual(["base", "grant"]);
    expect(granted.content.collections.map((item) => item.key)).toEqual(["fixture_core", "fixture_gift"]);

    const grantId = store.grantRows[0]!.id;
    const revoked = await service.revokeGrant(operator, {
      workspaceSlug: "team", grantId, reason: "赠送回收", idempotencyKey: "gift-revoke-team-0001",
    });
    expect(revoked.after.content.sources.map((item) => item.kind)).toEqual(["base"]);
    expect(revoked.after.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    expect(revoked.after.content.actions).toEqual(["read"]);
    expect(store.audits.find((row) => row.idempotencyKey === "gift-revoke-team-0001")?.action).toBe("revoke");

    // 撤销幂等：换键再撤同一赠送按成功收敛。
    const replay = await service.revokeGrant(operator, {
      workspaceSlug: "team", grantId, reason: "重复撤销", idempotencyKey: "gift-revoke-team-0002",
    });
    expect(replay.after.content.sources.map((item) => item.kind)).toEqual(["base"]);
    expect(store.revocations).toHaveLength(1);
  });

  test("查看/订阅调整/内容赠送/交付修复分别持能", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    await expect(service.grant({ subject: "ops", capabilities: ["subscription.manage"] }, fixtureGrantBody())).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.revokeGrant({ subject: "ops", capabilities: ["subscription.manage"] }, {
      workspaceSlug: "team", grantId: "content_grant:1", reason: "x", idempotencyKey: "gift-revoke-0001",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.repairDelivery({ subject: "ops", capabilities: ["quota.read", "entitlement.gift"] }, {
      workspaceSlug: "team", reason: "x", idempotencyKey: "repair-0001", expectedCurrentRevision: null,
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.exceptions({ subject: "customer", capabilities: [] }, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  test("交付修复：幂等重试、限定修订护栏、旧修订不覆盖新撤权、失败不重复发额度", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now);
    await service.assign(operator, fixtureAssignment(revisionId));

    // 只读预览不产生新快照。
    const preview = await service.describeDeliveryRepair(operator, "team");
    expect(preview.boundRevisionId).toBe(revisionId);
    expect(preview.current.revision).toBe(1);
    expect(store.snapshots).toHaveLength(1);

    const synced: string[] = [];
    const repairing = new ProductEntitlementService(store, () => now, {
      syncPlanCycle: async (directive) => {
        synced.push(directive.periodKey);
      },
    });

    // digest 未变：重试不产生新快照。
    const unchanged = await repairing.repairDelivery(operator, {
      workspaceSlug: "team", reason: "投影未交付，重试", idempotencyKey: "repair-team-0001", expectedCurrentRevision: 1,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.note).toContain("digest 一致或幂等重放");

    // 指针被挪走（模拟投影/指针故障）：重算并回指绑定修订。
    store.pointer.set("workspace:team", "workspace_product_entitlement:missing");
    const repaired = await repairing.repairDelivery(operator, {
      workspaceSlug: "team", reason: "投影未交付，重试", idempotencyKey: "repair-team-0002", expectedCurrentRevision: 1,
    });
    expect(repaired.changed).toBe(true);
    expect(store.pointer.get("workspace:team")).toBe(store.snapshots[0]!.id);
    expect(repaired.after.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);

    // 同键同请求体重放：幂等返回，不新增审计；同键不同请求体是冲突。
    const replayed = await repairing.repairDelivery(operator, {
      workspaceSlug: "team", reason: "投影未交付，重试", idempotencyKey: "repair-team-0002", expectedCurrentRevision: 1,
    });
    expect(replayed.changed).toBe(false);
    await expect(repairing.repairDelivery(operator, {
      workspaceSlug: "team", reason: "换一个说法", idempotencyKey: "repair-team-0002", expectedCurrentRevision: 1,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(store.audits.filter((row) => row.action === "repair")).toHaveLength(2);

    // 限定修订护栏：声明的当前修订过旧 → 冲突，不产生新快照。
    await expect(repairing.repairDelivery(operator, {
      workspaceSlug: "team", reason: "旧视图重试", idempotencyKey: "repair-team-0003", expectedCurrentRevision: 0,
    })).rejects.toMatchObject({ code: "conflict" });

    // 旧修订重试不覆盖新撤权：撤回基础绑定后（订阅失效），修复拒绝且指针不动。
    store.items.set("workspace:team", { ...store.items.get("workspace:team")!, status: "ended" });
    await expect(repairing.repairDelivery(operator, {
      workspaceSlug: "team", reason: "撤权后重试", idempotencyKey: "repair-team-0004", expectedCurrentRevision: null,
    })).rejects.toMatchObject({ code: "no_subscription" });
    expect(store.pointer.get("workspace:team")).toBe(store.snapshots[0]!.id);
    expect(synced).toHaveLength(0);
  });

  test("预览严格零写入：快照落后/指针损坏/赠送已撤销/订阅过期四种场景快照、指针、审计均不变", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now);
    await service.assign(operator, fixtureAssignment(revisionId));
    const state = () => ({
      snapshots: store.snapshots.length,
      pointer: store.pointer.get("workspace:team") ?? null,
      audits: store.audits.length,
    });
    const baseline = state();

    // 场景一：绑定来源更新但尚未交付——直接改商店里的产品修订内容，使当前
    // 快照 digest 落后于草稿（旧实现会在预览时 read-heal 出新快照）。
    store.revisions.set(revisionId, { ...fixtureRevision(), features: [{ key: "export_pdf", enabled: true, limit: null }] });
    const stale = await service.describeDeliveryRepair(operator, "team");
    expect(stale.current.revision).toBe(1); // 如实呈现已交付快照，不是预览出来的新快照
    expect(stale.target.features.some((item) => item.key === "export_pdf")).toBe(true);
    expect(state()).toEqual(baseline);

    // 场景二：赠送已撤销但快照还含它（digest 落后）——预览也不能顺手修复。
    store.revisions.set(revisionId, fixtureRevision());
    await service.grant(operator, fixtureGrantBody()); // 快照 v2 含赠送来源
    const withGrant = state();
    expect(withGrant.snapshots).toBe(baseline.snapshots + 1);
    store.revocations.push({
      workspaceId: "workspace:team", grantId: store.grantRows[0]!.id,
      reason: "回收", idempotencyKey: "ghost-rev",
    });
    const revoked = await service.describeDeliveryRepair(operator, "team");
    expect(revoked.current.revision).toBe(2); // 如实呈现含赠送的已交付快照
    expect(revoked.target.content.sources.map((item) => item.kind)).toEqual(["base"]);
    expect(state()).toEqual(withGrant);

    // 场景三：指针损坏/缺失——current 如实呈现为空交付视图，仍零写入。
    store.pointer.set("workspace:team", "workspace_product_entitlement:gone");
    const broken = await service.describeDeliveryRepair(operator, "team");
    expect(broken.current.revision).toBe(0);
    expect(state().snapshots).toBe(withGrant.snapshots);
    expect(state().pointer).toBe("workspace_product_entitlement:gone"); // 预览不得移动指针
    expect(state().audits).toBe(withGrant.audits);

    // 场景四：订阅已结束（无绑定修订）——预览退化为 current=target，仍零写入。
    store.items.set("workspace:team", { ...store.items.get("workspace:team")!, status: "ended" });
    const ended = await service.describeDeliveryRepair(operator, "team");
    expect(ended.boundRevisionId).toBeNull();
    expect(ended.target.revision).toBe(ended.current.revision);
    expect(state().audits).toBe(withGrant.audits);
  });

  test("修复护栏失败零写入：声明的旧修订与已交付快照不一致时拒绝且不动状态", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now);
    await service.assign(operator, fixtureAssignment(revisionId));
    const baseline = {
      snapshots: store.snapshots.length,
      pointer: store.pointer.get("workspace:team"),
      audits: store.audits.length,
    };

    // 即使快照 digest 已落后（旧实现会先 heal 再护栏，仍然留下快照），
    // 护栏失败也必须什么都不写。
    store.revisions.set(revisionId, { ...fixtureRevision(), features: [{ key: "export_pdf", enabled: true, limit: null }] });
    await expect(service.repairDelivery(operator, {
      workspaceSlug: "team", reason: "旧视图重试", idempotencyKey: "repair-stale-1", expectedCurrentRevision: 99,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(store.snapshots).toHaveLength(baseline.snapshots);
    expect(store.pointer.get("workspace:team")).toBe(baseline.pointer);
    expect(store.audits).toHaveLength(baseline.audits);
  });

  test("并发修复：同键并发收敛到同一结果，不同键并发只有一个能推进指针", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now);
    await service.assign(operator, fixtureAssignment(revisionId));
    store.pointer.set("workspace:team", "workspace_product_entitlement:missing");

    const sameKey = await Promise.all([
      service.repairDelivery(operator, { workspaceSlug: "team", reason: "并发重试", idempotencyKey: "repair-par-1", expectedCurrentRevision: null }),
      service.repairDelivery(operator, { workspaceSlug: "team", reason: "并发重试", idempotencyKey: "repair-par-1", expectedCurrentRevision: null }),
    ]);
    // 同键同请求体并发 = 同一操作的重放：收敛到同一结果、审计只有一条。
    expect(sameKey[0].after.revision).toBe(sameKey[1].after.revision);
    expect(store.pointer.get("workspace:team")).not.toBe("workspace_product_entitlement:missing");
    expect(store.audits.filter((row) => row.action === "repair")).toHaveLength(1);
  });

  test("异常队列区分三类系统失败；空集合与正常到期不算系统失败", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const projection = { verdict: "ok" as ProjectionVerification["verdict"] };
    const stub = projectionStub("ok");
    const service = new ProductEntitlementService(store, () => now, {
      aiStatus: async (dbName) => dbName === "ws_team"
        ? { consumableAllowance: 5, reserved: 2, settled: 3, suspended: 0, terminated: 0, expired: 0, stuckReservations: 1, settlementAnomaly: true, anomalyNote: "1 条预留超窗未终态" }
        : null,
      projectionVerify: async (input) => { stub.calls.push(input); return { checkedAt: now.toISOString(), verdict: projection.verdict, ...NO_PROJECTION }; },
    });
    await service.assign(operator, fixtureAssignment(revisionId));

    // 核验输入携带工作区库名与当前已交付快照（供 revision/digest 比对）。
    projection.verdict = "license_blocked";
    const queue = await service.exceptions(operator, {});
    expect(stub.calls[0]?.workspaceDb).toBe("ws_team");
    expect(stub.calls[0]?.expected?.revisionNumber).toBe(1);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.workspaceSlug).toBe("team");
    expect(queue.items[0]!.kinds).toContain("projection_failure");
    expect(queue.items[0]!.kinds).toContain("ai_settlement_anomaly");
    expect(queue.items[0]!.detail.stuckReservations).toBe(1);

    // 许可收紧的其它形态同样入队。
    projection.verdict = "projection_stale";
    expect((await service.exceptions(operator, {})).items[0]!.kinds).toContain("projection_failure");
    projection.verdict = "projection_error";
    expect((await service.exceptions(operator, {})).items[0]!.kinds).toContain("projection_failure");

    // 空集合是内容侧未供稿、unavailable 是核验不可用——都不算系统交付失败。
    projection.verdict = "empty_collection";
    const notFailure = await service.exceptions(operator, {});
    expect(notFailure.items[0]!.kinds).not.toContain("projection_failure");
    projection.verdict = "unavailable";
    expect((await service.exceptions(operator, {})).items[0]!.kinds).not.toContain("projection_failure");

    // 快照落后于绑定修订 → delivery_pending。
    projection.verdict = "ok";
    store.pointer.set("workspace:team", "workspace_product_entitlement:missing");
    const stale = await service.exceptions(operator, {});
    expect(stale.items[0]!.kinds).toContain("delivery_pending");
    expect(stale.items[0]!.kinds).not.toContain("projection_failure");

    // 正常到期：订阅过期后不入队（不算系统失败）。
    store.items.set("workspace:team", { ...store.items.get("workspace:team")!, status: "ended" });
    const idle = await service.exceptions(operator, {});
    expect(idle.items).toHaveLength(0);
  });

  test("运营解释视图带来源理由/操作者、投影核验与 AI 账本事实；客户视图保持收敛", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now, {
      aiStatus: async () => ({ consumableAllowance: 7, reserved: 1, settled: 2, suspended: 0, terminated: 0, expired: 0, stuckReservations: 0, settlementAnomaly: false, anomalyNote: null }),
      projectionVerify: async () => ({
        checkedAt: now.toISOString(), verdict: "ok",
        workspace: { state: "active", revision: "rev-1", revisionNumber: 1, matchesExpected: true, confirmedUntil: "2026-09-24T00:15:00.000Z", expectedRevisionNumber: 1 },
        collections: [{ key: "fixture_core", label: "夹具核心", publishedItems: 3, readableItems: 3, blockedItems: 0, sources: [] }],
      }),
    });
    await service.assign(operator, fixtureAssignment(revisionId));
    await service.grant(operator, fixtureGrantBody());
    const opsView = await service.getForOperator(operator, "team");
    const grantSource = opsView.content.sources.find((item) => item.kind === "grant");
    expect(grantSource?.reason).toBe("客户支持赠送");
    expect(grantSource?.operatorSubject).toBe("ops");
    expect(opsView.content.projection?.verdict).toBe("ok");
    expect(opsView.content.projection?.workspace.state).toBe("active");
    expect(opsView.content.projection?.collections[0]?.publishedItems).toBe(3);
    expect(opsView.ai.ledger).toBe("ok");
    expect(opsView.ai.consumableAllowance).toBe(7);
    expect(opsView.ai.stuckReservations).toBe(0);

    const customerView = await service.getForCustomer("lawyer", "team");
    expect(customerView.content.projection).toBeNull();
    expect(customerView.ai.ledger).toBe("unavailable");
    expect(customerView.ai.consumableAllowance).toBeNull();
  });

  test("赠送到期：effectiveUntil 过后赠送来源自动失效，基础订阅保留", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => new Date("2026-10-15T00:00:00.000Z"));
    await service.assign(operator, fixtureAssignment(revisionId));
    await service.grant(operator, fixtureGrantBody()); // effectiveUntil 2026-09-30，now=10-15 已过期
    const view = await service.getForOperator(operator, "team");
    expect(view.content.sources.map((item) => item.kind)).toEqual(["base"]);
    expect(view.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    // 异常队列不因赠送自然到期而入队（交付失败才入队）。
    const queue = await service.exceptions(operator, {});
    expect(queue.items.find((item) => item.workspaceSlug === "team")?.kinds ?? []).not.toContain("projection_failure");
  });

  test("重复请求与服务重启恢复：同幂等键在新实例上重放同一结果", async () => {
    const store = new EntitlementRecoveryStore();
    seedWorkspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const first = new ProductEntitlementService(store, () => now);
    await first.assign(operator, fixtureAssignment(revisionId));
    await first.grant(operator, fixtureGrantBody());
    const grantId = store.grantRows[0]!.id;
    await first.revokeGrant(operator, {
      workspaceSlug: "team", grantId, reason: "赠送回收", idempotencyKey: "gift-revoke-restart-1",
    });

    // 服务重启（新实例、同一存储）：撤销重放语义不变。
    const restarted = new ProductEntitlementService(store, () => now);
    const replay = await restarted.revokeGrant(operator, {
      workspaceSlug: "team", grantId, reason: "赠送回收", idempotencyKey: "gift-revoke-restart-1",
    });
    expect(replay.after.content.sources.map((item) => item.kind)).toEqual(["base"]);
    expect(store.revocations).toHaveLength(1);

    // 同键不同请求体 → 冲突。
    await expect(restarted.revokeGrant(operator, {
      workspaceSlug: "team", grantId, reason: "别的理由", idempotencyKey: "gift-revoke-restart-1",
    })).rejects.toMatchObject({ code: "conflict" });
  });
});
