import { describe, expect, test } from "bun:test";
import type { GrantContentCollection } from "@surreal-ck/shared";
import type { ContentGrantFact, ProductRevisionBody, ResourceFact, SubscriptionFact } from "./resolve";
import { ProductEntitlementService, type AuditRecord, type GrantFactRow, type ProductActor, type ProductEntitlementStore, type SnapshotRecord, type WorkspaceRef, type WorkspaceRuntimeRef } from "./service";

type GrantRow = ContentGrantFact & {
  reason: string | null;
  actor: string | null;
  idempotencyKey: string | null;
};

class RecoveryStore implements ProductEntitlementStore {
  workspaces = new Map<string, WorkspaceRef>();
  members = new Set<string>();
  items = new Map<string, SubscriptionFact>();
  revisions = new Map<string, ProductRevisionBody>();
  resources = new Set<string>();
  grantRows: GrantRow[] = [];
  revocations: { workspaceId: string; grantId: string; reason: string; idempotencyKey: string }[] = [];
  snapshots: SnapshotRecord[] = [];
  pointer = new Map<string, string>();
  audits: (AuditRecord & { actor: string; idempotencyKey: string; workspaceId: string | null })[] = [];
  resource: ResourceFact = { appliedPlanKey: null, appliedPlanName: null, appliedRevision: null, desiredPlanKey: null, syncState: null };
  private sequence = 0;

  async workspaceBySlug(slug: string) { return [...this.workspaces.values()].find((item) => item.slug === slug) ?? null; }
  dbNames = new Map<string, string>();
  async workspaceById(id: string) {
    const ref = this.workspaces.get(id);
    return ref ? { ...ref, dbName: this.dbNames.get(id) ?? `ws_${ref.slug}` } : null;
  }
  async membership(subject: string, workspaceId: string) { return this.members.has(`${subject}:${workspaceId}`) ? "admin" as const : null; }
  async activeItem(workspaceId: string) { return this.items.get(workspaceId) ?? null; }
  async bindProductRevision(itemId: string, productPlanRevisionId: string) {
    for (const [workspaceId, item] of this.items) if (item.itemId === itemId) this.items.set(workspaceId, { ...item, productPlanRevisionId });
  }
  async productRevision(id: string) { return this.revisions.get(id) ?? null; }
  async resourceTemplateExists(id: string) { return this.resources.has(id); }
  async upsertCollection(key: string, label: string) { return { id: `content_collection:${key}`, key, label }; }
  async insertContentTemplate() { return `content_template_revision:${++this.sequence}`; }
  async insertAiTemplate() { return `ai_template_revision:${++this.sequence}`; }
  async insertFeatureTemplate() { return `feature_template_revision:${++this.sequence}`; }
  async upsertPlan(planKey: string) { return `product_plan:${planKey}`; }
  async productRevisionId() { return null; }
  async insertProductRevision(): Promise<string | null> { return null; }
  async setActiveRevision() {}
  async grants() {
    return this.grantRows
      .filter((row) => !this.revocations.some((revoke) => revoke.grantId === row.id))
      .map(({ reason: _reason, actor: _actor, idempotencyKey: _key, ...fact }) => fact);
  }
  async insertGrant(_workspaceId: string, grant: Omit<ContentGrantFact, "id" | "collections"> & { collections: { id: string; key: string; label: string }[]; reason: string; actor: string; idempotencyKey: string }) {
    const existing = this.grantRows.find((item) => item.idempotencyKey === grant.idempotencyKey);
    if (existing) return existing.id;
    const id = `content_grant:${++this.sequence}`;
    this.grantRows.push({
      ...grant,
      collections: grant.collections.map((item) => ({ key: item.key, label: item.label })),
      id, reason: grant.reason, actor: grant.actor, idempotencyKey: grant.idempotencyKey,
    });
    return id;
  }
  async grantFacts(workspaceId: string): Promise<GrantFactRow[]> {
    return this.grantRows.map((row) => ({
      ...row,
      operatorSubject: row.actor,
      revoked: this.revocations.some((revoke) => revoke.workspaceId === workspaceId && revoke.grantId === row.id),
    }));
  }
  async grantById(workspaceId: string, grantId: string): Promise<GrantFactRow | null> {
    const row = this.grantRows.find((item) => item.id === grantId);
    if (!row) return null;
    const revoke = this.revocations.find((item) => item.grantId === grantId);
    return { ...row, operatorSubject: row.actor, revoked: revoke !== undefined, revokeReason: revoke?.reason ?? null };
  }
  async insertGrantRevocation(workspaceId: string, grantId: string, reason: string, _actor: string, idempotencyKey: string): Promise<"ok" | "replayed" | "conflict"> {
    if (this.revocations.some((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey)) return "replayed";
    if (this.revocations.some((item) => item.grantId === grantId)) return "replayed";
    this.revocations.push({ workspaceId, grantId, reason, idempotencyKey });
    return "ok";
  }
  async deliveryCandidates(limit: number, offset: number): Promise<WorkspaceRuntimeRef[]> {
    // 与真实实现一致：只列仍挂在活跃订阅项上的工作区（自然到期不入候选）。
    return [...this.workspaces.values()]
      .filter((ref) => this.items.get(ref.id)?.status === "active")
      .map((ref) => ({ ...ref, dbName: this.dbNames.get(ref.id) ?? `ws_${ref.slug}` }))
      .slice(offset, offset + limit);
  }
  async currentSnapshot(workspaceId: string) {
    const id = this.pointer.get(workspaceId);
    return this.snapshots.find((item) => item.id === id) ?? null;
  }
  async snapshotById(id: string) { return this.snapshots.find((item) => item.id === id) ?? null; }
  async snapshotByDigest(workspaceId: string, digest: string) {
    return this.snapshots.find((item) => item.workspaceId === workspaceId && item.digest === digest) ?? null;
  }
  async newestSnapshotRevision(workspaceId: string, productPlanRevisionId: string) {
    const revisions = this.snapshots.filter((item) => item.workspaceId === workspaceId && item.productPlanRevisionId === productPlanRevisionId).map((item) => item.revision);
    return revisions.length === 0 ? null : Math.max(...revisions);
  }
  async insertSnapshot(row: SnapshotRecord): Promise<"ok" | "conflict"> {
    if (this.snapshots.some((item) => item.workspaceId === row.workspaceId && (item.revision === row.revision || item.digest === row.digest))) return "conflict";
    this.snapshots.push({ ...row, id: `workspace_product_entitlement:${++this.sequence}` });
    return "ok";
  }
  async pointWorkspace(workspaceId: string, snapshotId: string) {
    const next = this.snapshots.find((item) => item.id === snapshotId);
    if (!next) return;
    const item = this.items.get(workspaceId);
    const bound = item && item.status === "active"
      && item.effectiveFrom <= "2026-09-24T00:00:00.000Z"
      && (item.effectiveUntil === null || item.effectiveUntil > "2026-09-24T00:00:00.000Z")
      && (item.subscriptionStatus === "active" || item.subscriptionStatus === "trialing")
      ? item.productPlanRevisionId : null;
    const current = this.snapshots.find((item) => item.id === this.pointer.get(workspaceId));
    if (current && current.revision >= next.revision && !(bound !== null && next.productPlanRevisionId === bound)) return;
    this.pointer.set(workspaceId, snapshotId);
  }
  async auditByKey(actor: string, idempotencyKey: string) {
    return this.audits.find((item) => item.actor === actor && item.idempotencyKey === idempotencyKey) ?? null;
  }
  async insertAudit(row: AuditRecord & { actor: string; idempotencyKey: string; reason: string; workspaceId: string | null }) {
    if (await this.auditByKey(row.actor, row.idempotencyKey)) return "conflict";
    this.audits.push(row);
    return "ok";
  }
  async attachAuditEntitlement(actor: string, idempotencyKey: string, entitlementId: string) {
    const row = this.audits.find((item) => item.actor === actor && item.idempotencyKey === idempotencyKey);
    if (!row) return "conflict";
    if (row.entitlementId && row.entitlementId !== entitlementId) return "conflict";
    row.entitlementId = entitlementId;
    return "ok";
  }
  async resourceStatus() { return this.resource; }
}

function workspace(store: RecoveryStore, overrides: Partial<SubscriptionFact> = {}) {
  const ref = { id: "workspace:team", slug: "team" };
  store.workspaces.set(ref.id, ref);
  store.dbNames.set(ref.id, "ws_team");
  store.members.add("lawyer:workspace:team");
  store.resources.add("quota_plan_revision:fixture");
  store.items.set(ref.id, {
    itemId: "quota_subscription_item:team", status: "active", effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: "2026-12-01T00:00:00.000Z", productPlanRevisionId: null,
    subscriptionId: "quota_subscription:team", billingAccountKey: "acct-a", subscriptionStatus: "active",
    ...overrides,
  });
  store.resource = { appliedPlanKey: "plus", appliedPlanName: "Plus 资源", appliedRevision: 3, desiredPlanKey: "plus", syncState: "synced" };
}

const operator: ProductActor = { subject: "ops", capabilities: ["quota.read", "subscription.manage", "entitlement.gift", "entitlement.repair"] };

function fixtureRevision(id = "product_plan_revision:fixture:1"): ProductRevisionBody {
  return {
    id, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
    collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["read"], aiActions: [], features: [],
  };
}

function assignment(revisionId: string) {
  return { workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId: revisionId, reason: "为夹具工作区开通", idempotencyKey: "assign-team-0001" };
}

function grantBody(overrides: Partial<GrantContentCollection> = {}): GrantContentCollection {
  return {
    workspaceSlug: "team", label: "临时赠送夹具", collections: [{ key: "fixture_gift", label: "赠送夹具" }],
    actions: ["read", "cite"], effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-09-30T00:00:00.000Z",
    reason: "客户支持赠送", idempotencyKey: "gift-team-0001", ...overrides,
  };
}

describe("LCA13 运营解释、临时授权与交付修复", () => {
  test("赠送是与基础订阅重叠的独立来源；撤销只移除该来源，基础授权保留", async () => {
    const store = new RecoveryStore();
    workspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const service = new ProductEntitlementService(store, () => now);
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    await service.assign(operator, assignment(revisionId));
    const granted = await service.grant(operator, grantBody());
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
    const store = new RecoveryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    await expect(service.grant({ subject: "ops", capabilities: ["subscription.manage"] }, grantBody())).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.revokeGrant({ subject: "ops", capabilities: ["subscription.manage"] }, {
      workspaceSlug: "team", grantId: "content_grant:1", reason: "x", idempotencyKey: "gift-revoke-0001",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.repairDelivery({ subject: "ops", capabilities: ["quota.read", "entitlement.gift"] }, {
      workspaceSlug: "team", reason: "x", idempotencyKey: "repair-0001", expectedCurrentRevision: null,
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.exceptions({ subject: "customer", capabilities: [] }, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  test("交付修复：幂等重试、限定修订护栏、旧修订不覆盖新撤权、失败不重复发额度", async () => {
    const store = new RecoveryStore();
    workspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now);
    await service.assign(operator, assignment(revisionId));

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

  test("异常队列区分三类系统失败；正常到期不入队", async () => {
    const store = new RecoveryStore();
    workspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const projection = { verdict: "ok" as "ok" | "empty_collection" };
    const service = new ProductEntitlementService(store, () => now, {
      aiStatus: async (dbName) => dbName === "ws_team"
        ? { consumableAllowance: 5, reserved: 2, settled: 3, suspended: 0, terminated: 0, expired: 0, stuckReservations: 1, settlementAnomaly: true, anomalyNote: "1 条预留超窗未终态" }
        : null,
      projectionVerify: async () => ({ checkedAt: now.toISOString(), verdict: projection.verdict, collections: [] }),
    });
    await service.assign(operator, assignment(revisionId));

    // 快照就绪 + 投影故障 → projection_failure（此刻指针正常，无 delivery_pending）。
    projection.verdict = "empty_collection";
    const queue = await service.exceptions(operator, {});
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.workspaceSlug).toBe("team");
    expect(queue.items[0]!.kinds).toContain("projection_failure");
    expect(queue.items[0]!.kinds).toContain("ai_settlement_anomaly");
    expect(queue.items[0]!.detail.stuckReservations).toBe(1);

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
    const store = new RecoveryStore();
    workspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const service = new ProductEntitlementService(store, () => now, {
      aiStatus: async () => ({ consumableAllowance: 7, reserved: 1, settled: 2, suspended: 0, terminated: 0, expired: 0, stuckReservations: 0, settlementAnomaly: false, anomalyNote: null }),
      projectionVerify: async () => ({
        checkedAt: now.toISOString(), verdict: "ok",
        collections: [{ key: "fixture_core", label: "夹具核心", publishedItems: 3, licenseUntil: "2026-10-31T00:00:00.000Z", licenseActions: ["read", "cite"] }],
      }),
    });
    await service.assign(operator, assignment(revisionId));
    await service.grant(operator, grantBody());
    const opsView = await service.getForOperator(operator, "team");
    const grantSource = opsView.content.sources.find((item) => item.kind === "grant");
    expect(grantSource?.reason).toBe("客户支持赠送");
    expect(grantSource?.operatorSubject).toBe("ops");
    expect(opsView.content.projection?.verdict).toBe("ok");
    expect(opsView.content.projection?.collections[0]?.publishedItems).toBe(3);
    expect(opsView.ai.ledger).toBe("ok");
    expect(opsView.ai.consumableAllowance).toBe(7);
    expect(opsView.ai.stuckReservations).toBe(0);

    const customerView = await service.getForCustomer("lawyer", "team");
    expect(customerView.content.projection).toBeNull();
    expect(customerView.ai.ledger).toBe("unavailable");
    expect(customerView.ai.consumableAllowance).toBeNull();
  });

  test("重复请求与服务重启恢复：同幂等键在新实例上重放同一结果", async () => {
    const store = new RecoveryStore();
    workspace(store);
    const now = new Date("2026-09-24T00:00:00.000Z");
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, fixtureRevision());
    const first = new ProductEntitlementService(store, () => now);
    await first.assign(operator, assignment(revisionId));
    await first.grant(operator, grantBody());
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
