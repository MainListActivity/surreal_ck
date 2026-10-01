import { describe, expect, test } from "bun:test";
import type { AssignProductEntitlement, GrantContentCollection, PublishProductRevision } from "@surreal-ck/shared";
import { resolveEntitlement, type ContentGrantFact, type FeatureValue, type ProductRevisionBody, type ResourceFact, type SubscriptionFact } from "./resolve";
import { ProductEntitlementService, type AuditRecord, type ProductActor, type ProductEntitlementStore, type SnapshotRecord, type WorkspaceRef } from "./service";

class MemoryStore implements ProductEntitlementStore {
  workspaces = new Map<string, WorkspaceRef>();
  members = new Set<string>();
  items = new Map<string, SubscriptionFact>();
  revisions = new Map<string, ProductRevisionBody>();
  plans = new Map<string, { id: string; active?: string }>();
  resources = new Set<string>();
  grantRows: (ContentGrantFact & { idempotencyKey?: string })[] = [];
  snapshots: SnapshotRecord[] = [];
  pointer = new Map<string, string>();
  audits: (AuditRecord & { actor: string; idempotencyKey: string })[] = [];
  resource: ResourceFact = { appliedPlanKey: null, appliedPlanName: null, appliedRevision: null, desiredPlanKey: null, syncState: null };
  failNextInsert = false;
  now = "2026-09-24T00:00:00.000Z";
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
  async upsertPlan(planKey: string) {
    const existing = this.plans.get(planKey);
    if (existing) return existing.id;
    const id = `product_plan:${planKey}`;
    this.plans.set(planKey, { id });
    return id;
  }
  async productRevisionId(planId: string, revision: number) {
    return [...this.revisions.values()].find((item) => item.revision === revision && item.id.includes(planId))?.id ?? null;
  }
  async insertProductRevision(input: { planId: string; revision: number; resourceTemplateId: string; contentTemplateId: string; aiTemplateId: string; featureTemplateId: string }): Promise<string | null> {
    if ([...this.revisions.values()].some((item) => item.revision === input.revision && item.id.includes(input.planId))) return null;
    const id = `product_plan_revision:${input.planId}:${input.revision}`;
    const pending = this.pendingRevision.get(id);
    if (!pending) return null;
    this.revisions.set(id, { ...pending, id });
    this.pendingRevision.delete(id);
    return id;
  }
  pendingRevision = new Map<string, Omit<ProductRevisionBody, "id">>();
  async setActiveRevision(planId: string, revisionId: string) {
    const next = this.revisions.get(revisionId);
    for (const plan of this.plans.values()) {
      if (plan.id !== planId) continue;
      const current = plan.active ? this.revisions.get(plan.active) : null;
      if (current && next && current.revision >= next.revision) return;
      plan.active = revisionId;
    }
  }
  async grants() { return this.grantRows.filter((row) => !this.revocations.some((revoke) => revoke.grantId === row.id)); }
  revocations: { workspaceId: string; grantId: string; reason: string; idempotencyKey: string }[] = [];
  async grantFacts(workspaceId: string) {
    return this.grantRows.map((row) => ({
      ...row,
      reason: typeof row.reason === "string" ? row.reason : null,
      operatorSubject: typeof row.actor === "string" ? row.actor : null,
      idempotencyKey: row.idempotencyKey ?? null,
      revoked: this.revocations.some((revoke) => revoke.workspaceId === workspaceId && revoke.grantId === row.id),
    }));
  }
  async grantById(workspaceId: string, grantId: string) {
    const row = this.grantRows.find((item) => item.id === grantId);
    if (!row) return null;
    const revoke = this.revocations.find((item) => item.grantId === grantId);
    return {
      ...row,
      reason: typeof row.reason === "string" ? row.reason : null,
      operatorSubject: typeof row.actor === "string" ? row.actor : null,
      idempotencyKey: row.idempotencyKey ?? null,
      revoked: revoke !== undefined,
      revokeReason: revoke?.reason ?? null,
    };
  }
  async insertGrantRevocation(workspaceId: string, grantId: string, reason: string, _actor: string, idempotencyKey: string) {
    if (this.revocations.some((item) => item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey)) return "replayed" as const;
    if (this.revocations.some((item) => item.grantId === grantId)) return "replayed" as const;
    this.revocations.push({ workspaceId, grantId, reason, idempotencyKey });
    return "ok" as const;
  }
  async deliveryCandidates(limit: number, offset: number) {
    const all = [...this.workspaces.values()].map((ref) => ({ ...ref, dbName: this.dbNames.get(ref.id) ?? `ws_${ref.slug}` }));
    return all.slice(offset, offset + limit);
  }
  async insertGrant(_workspaceId: string, grant: ContentGrantFact & { idempotencyKey: string }) {
    const existing = this.grantRows.find((item) => item.idempotencyKey === grant.idempotencyKey);
    if (existing) return existing.id;
    const id = `content_grant:${++this.sequence}`;
    this.grantRows.push({ ...grant, id });
    return id;
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
    const revisions = this.snapshots
      .filter((item) => item.workspaceId === workspaceId && item.productPlanRevisionId === productPlanRevisionId)
      .map((item) => item.revision);
    return revisions.length === 0 ? null : Math.max(...revisions);
  }
  async insertSnapshot(row: SnapshotRecord) {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      return "conflict" as const;
    }
    if (this.snapshots.some((item) => item.workspaceId === row.workspaceId && (item.revision === row.revision || item.digest === row.digest))) return "conflict" as const;
    const saved = { ...row, id: `workspace_product_entitlement:${++this.sequence}` };
    this.snapshots.push(saved);
    return "ok" as const;
  }
  async pointWorkspace(workspaceId: string, snapshotId: string) {
    const next = this.snapshots.find((item) => item.id === snapshotId);
    if (!next) return;
    const item = this.items.get(workspaceId);
    const bound = item && item.status === "active"
      && item.effectiveFrom <= this.now
      && (item.effectiveUntil === null || item.effectiveUntil > this.now)
      && (item.subscriptionStatus === "active" || item.subscriptionStatus === "trialing")
      ? item.productPlanRevisionId : null;
    const current = this.snapshots.find((item) => item.id === this.pointer.get(workspaceId));
    if (current && current.revision >= next.revision
      && !(bound !== null && next.productPlanRevisionId === bound)) return;
    this.pointer.set(workspaceId, snapshotId);
  }
  async auditByKey(actor: string, idempotencyKey: string) {
    return this.audits.find((item) => item.actor === actor && item.idempotencyKey === idempotencyKey) ?? null;
  }
  async insertAudit(row: AuditRecord & { actor: string; idempotencyKey: string }) {
    if (await this.auditByKey(row.actor, row.idempotencyKey)) return "conflict" as const;
    this.audits.push(row);
    return "ok" as const;
  }
  async attachAuditEntitlement(actor: string, idempotencyKey: string, entitlementId: string) {
    const row = this.audits.find((item) => item.actor === actor && item.idempotencyKey === idempotencyKey);
    if (!row) return "conflict" as const;
    if (row.entitlementId && row.entitlementId !== entitlementId) return "conflict" as const;
    row.entitlementId = entitlementId;
    return "ok" as const;
  }
  async resourceStatus() { return this.resource; }
}

function workspace(store: MemoryStore) {
  const ref = { id: "workspace:team", slug: "team" };
  store.workspaces.set(ref.id, ref);
  store.members.add("lawyer:workspace:team");
  store.resources.add("quota_plan_revision:fixture");
  store.items.set(ref.id, {
    itemId: "quota_subscription_item:team", status: "active", effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: "2026-10-01T00:00:00.000Z", productPlanRevisionId: null,
    subscriptionId: "quota_subscription:team", billingAccountKey: "acct-a", subscriptionStatus: "active",
  });
  store.resource = { appliedPlanKey: "plus", appliedPlanName: "Plus 资源", appliedRevision: 3, desiredPlanKey: "plus", syncState: "synced" };
}

const operator: ProductActor = { subject: "ops", capabilities: ["subscription.manage", "quota.read", "entitlement.gift", "entitlement.repair"] };

function publishBody(revision: number, key: string, label: string): PublishProductRevision {
  return {
    planKey: "fixture_plus", displayName: "夹具律师 Plus", revision, resourceTemplateId: "quota_plan_revision:fixture",
    collections: [{ key, label }], actions: ["browse", "search", "read"], aiActions: ["research"],
    features: [{ key: "audit_export", enabled: true, limit: null }], reason: "发布夹具版本", idempotencyKey: `publish-${revision}-key`,
  };
}

describe("product entitlement", () => {
  test("分配夹具套餐、幂等重试、并发解析和旧资源订阅互不改写", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const remember = store.insertProductRevision.bind(store);
    store.insertProductRevision = async (input) => {
      const id = `product_plan_revision:${input.planId}:${input.revision}`;
      store.pendingRevision.set(id, {
        planKey: "fixture_plus", planName: "夹具律师 Plus", revision: input.revision,
        collections: input.revision === 1 ? [{ key: "fixture_core", label: "夹具核心" }] : [{ key: "fixture_expanded", label: "夹具扩展" }],
        actions: ["browse", "search", "read"], aiActions: ["research"], features: [{ key: "audit_export", enabled: true, limit: null }],
      });
      return remember(input);
    };

    const published = await service.publishRevision(operator, publishBody(1, "fixture_core", "夹具核心"));
    store.failNextInsert = true;
    const assigned = await service.assign(operator, {
      workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId: published.productPlanRevisionId,
      reason: "为夹具工作区开通", idempotencyKey: "assign-team-0001",
    });
    expect(assigned.content.projectionLabel).toBe("待交付");
    expect(assigned.content.consumesAiAllowance).toBe(false);
    expect(assigned.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    expect(assigned.ai.consumableAllowance).toBeNull();
    expect(assigned.ai.ledger).toBe("unavailable");
    expect(assigned.resource).toMatchObject({ appliedPlanKey: "plus", appliedPlanName: "Plus 资源", status: "applied", statusLabel: "已生效" });
    expect(JSON.stringify(assigned)).not.toContain("lawyer_plus");

    const repeated = await service.assign(operator, {
      workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId: published.productPlanRevisionId,
      reason: "为夹具工作区开通", idempotencyKey: "assign-team-0001",
    });
    expect(repeated.revision).toBe(assigned.revision);
    expect(store.snapshots).toHaveLength(1);

    await service.publishRevision(operator, publishBody(2, "fixture_expanded", "夹具扩展"));
    const unchanged = await service.getForOperator(operator, "team");
    expect(unchanged.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    expect(store.items.get("workspace:team")).toMatchObject({
      productPlanRevisionId: published.productPlanRevisionId,
      subscriptionId: "quota_subscription:team",
      subscriptionStatus: "active",
    });
  });

  test("指派到低配产品再恢复同 digest 产品时指针回指", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    store.insertProductRevision = async (input) => {
      const id = `product_plan_revision:${input.planId}:${input.revision}`;
      store.pendingRevision.set(id, {
        planKey: input.planId.endsWith(":fixture_plus") ? "fixture_plus" : "fixture_meta",
        planName: input.planId.endsWith(":fixture_plus") ? "夹具律师 Plus" : "夹具元数据",
        revision: input.revision,
        collections: [{ key: "fixture_core", label: "夹具核心" }],
        actions: input.planId.endsWith(":fixture_plus") ? ["browse", "search", "read"] : ["browse"],
        aiActions: [], features: [] as FeatureValue[],
      });
      const created = `product_plan_revision:${input.planId}:${input.revision}`;
      store.revisions.set(created, { ...store.pendingRevision.get(id)!, id: created });
      return created;
    };
    const full = await service.publishRevision(operator, publishBody(1, "fixture_core", "夹具核心"));
    const meta = await service.publishRevision(operator, {
      ...publishBody(1, "fixture_core", "夹具核心"),
      planKey: "fixture_meta", displayName: "夹具元数据", actions: ["browse"], aiActions: [],
      idempotencyKey: "publish-meta-001",
    });

    const assigned = await service.assign(operator, { ...assignment(full.productPlanRevisionId), idempotencyKey: "assign-full-001" });
    expect(assigned.revision).toBe(1);
    expect(assigned.content.actions).toEqual(["browse", "read", "search"]);

    const lowered = await service.assign(operator, { ...assignment(meta.productPlanRevisionId), idempotencyKey: "assign-meta-001" });
    expect(lowered.revision).toBe(2);
    expect(lowered.content.actions).toEqual(["browse"]);

    const restored = await service.assign(operator, { ...assignment(full.productPlanRevisionId), idempotencyKey: "assign-full-002" });
    expect(restored.revision).toBe(assigned.revision);

    const current = await store.currentSnapshot("workspace:team");
    expect(current?.revision).toBe(assigned.revision);
    const view = await service.getForCustomer("lawyer", "team");
    expect(view.revision).toBe(assigned.revision);
    expect(view.content.actions).toEqual(["browse", "read", "search"]);
    expect(store.snapshots).toHaveLength(2);
  });

  test("同号重发：内容一致的幂等重放返回既有修订，内容差异报 conflict 不静默吞掉", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const remember = store.insertProductRevision.bind(store);
    store.insertProductRevision = async (input) => {
      const id = `product_plan_revision:${input.planId}:${input.revision}`;
      store.pendingRevision.set(id, {
        planKey: "fixture_plus", planName: "夹具律师 Plus", revision: input.revision,
        collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["browse", "search", "read"],
        aiActions: [], features: [{ key: "audit_export", enabled: true, limit: null }],
      });
      return remember(input);
    };
    const first = await service.publishRevision(operator, { ...publishBody(1, "fixture_core", "夹具核心"), aiActions: [] });
    // 内容一致 + 新幂等键 → 幂等重放，返回既有修订 id。
    const replay = await service.publishRevision(operator, { ...publishBody(1, "fixture_core", "夹具核心"), aiActions: [], idempotencyKey: "publish-replay-key" });
    expect(replay.productPlanRevisionId).toBe(first.productPlanRevisionId);
    // 内容差异（补 aiActions）→ conflict，绝不静默返回旧修订（LCA05 生产教训）。
    await expect(service.publishRevision(operator, { ...publishBody(1, "fixture_core", "夹具核心"), idempotencyKey: "publish-divergent-key" }))
      .rejects.toMatchObject({ code: "conflict" });
    // 顺序不敏感：actions 集合相同、顺序不同 → 仍视为重放。
    const reordered = await service.publishRevision(operator, {
      ...publishBody(1, "fixture_core", "夹具核心"), aiActions: [], actions: ["read", "browse", "search"],
      idempotencyKey: "publish-reordered-key",
    });
    expect(reordered.productPlanRevisionId).toBe(first.productPlanRevisionId);
    // 修订号必须前进：发布 rev2 才能真正携带新内容。
    const second = await service.publishRevision(operator, publishBody(2, "fixture_core", "夹具核心"));
    expect(second.productPlanRevisionId).not.toBe(first.productPlanRevisionId);
  });

  test("到期、无产品来源、跨计费账户和内容增量按已确认规则解析", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const untouched = await service.getForCustomer("lawyer", "team");
    expect(untouched.summary).toBe("无有效内容授权");
    expect(untouched.content.collections).toEqual([]);
    expect(untouched.resource.appliedPlanName).toBe("Plus 资源");
    await expect(service.getForCustomer("stranger", "team")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.assign(operator, {
      workspaceSlug: "team", billingAccountKey: "acct-b", productPlanRevisionId: "product_plan_revision:missing",
      reason: "错误账户", idempotencyKey: "assign-cross-001",
    })).rejects.toMatchObject({ code: "cross_account" });

    store.insertProductRevision = async (input) => {
      const id = `product_plan_revision:${input.planId}:${input.revision}`;
      store.pendingRevision.set(id, {
        planKey: "fixture_plus", planName: "夹具律师 Plus", revision: input.revision,
        collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["browse", "search", "read"],
        aiActions: ["research"], features: [] as FeatureValue[],
      });
      const created = `product_plan_revision:${input.planId}:${input.revision}`;
      store.revisions.set(created, { ...store.pendingRevision.get(id)!, id: created });
      return created;
    };
    const published = await service.publishRevision(operator, publishBody(1, "fixture_core", "夹具核心"));
    await expect(service.assign({ subject: "ops", capabilities: ["quota.read"] }, assignment(published.productPlanRevisionId))).rejects.toMatchObject({ code: "forbidden" });
    expect((await service.assign(operator, assignment(published.productPlanRevisionId))).revision).toBe(1);
    const grant: GrantContentCollection = {
      workspaceSlug: "team", label: "夹具专题", collections: [{ key: "fixture_topic", label: "夹具专题" }],
      actions: ["cite"], effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z",
      reason: "增加夹具专题", idempotencyKey: "grant-topic-001",
    };
    const expanded = await service.grant(operator, grant);
    expect(expanded.content.collections.map((item) => item.key)).toEqual(["fixture_core", "fixture_topic"]);
    expect(expanded.content.actions).toContain("cite");
    expect(store.snapshots).toHaveLength(2);
    expect(store.snapshots[0]?.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    // 回指到当前绑定产品的旧快照是纠偏（恢复指派场景），允许。
    const currentId = store.pointer.get("workspace:team");
    await store.pointWorkspace("workspace:team", store.snapshots[0]!.id);
    expect(store.pointer.get("workspace:team")).toBe(store.snapshots[0]!.id);
    expect(currentId).not.toBe(store.snapshots[0]!.id);
    await store.pointWorkspace("workspace:team", currentId!);

    store.items.set("workspace:team", { ...store.items.get("workspace:team")!, effectiveUntil: "2026-09-02T00:00:00.000Z" });
    const read = await service.getForCustomer("lawyer", "team");
    expect(read.summary).toBe("无有效内容授权");
    expect(read.content.projectionLabel).toBe("无有效内容授权");
    expect(read.baseSource.kind).toBe("none");
    expect(read.revision).toBeGreaterThan(expanded.revision);
    expect(store.snapshots[0]?.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    const expired = await service.assign(operator, { ...assignment(published.productPlanRevisionId), idempotencyKey: "assign-expired-01" });
    expect(expired.summary).toBe("无有效内容授权");
    expect(expired.content.collections).toEqual([]);
    expect(expired.baseSource.kind).toBe("none");
    expect(store.snapshots[0]?.collections.map((item) => item.key)).toEqual(["fixture_core"]);
  });

  test("版本已写入但没有审计时，重试返回原版本且不再插入模板", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const planId = await store.upsertPlan("fixture_plus");
    const revisionId = `product_plan_revision:${planId}:1`;
    // 崩溃恢复场景：修订行已写入（内容 = 完整发布体），审计还没落。重试同体必须幂等返回且不再插模板。
    store.revisions.set(revisionId, {
      id: revisionId, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["browse", "search", "read"],
      aiActions: ["research"], features: [{ key: "audit_export", enabled: true, limit: null }],
    });
    let templates = 0;
    store.insertContentTemplate = async () => {
      templates += 1;
      return "content_template_revision:extra";
    };
    const published = await service.publishRevision(operator, publishBody(1, "fixture_core", "夹具核心"));
    expect(published.productPlanRevisionId).toBe(revisionId);
    expect(templates).toBe(0);
    expect(store.audits).toHaveLength(1);
  });

  test("快照写失败时不绑定订阅，同一幂等键可以恢复", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, {
      id: revisionId, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["read"], aiActions: [],
      features: [{ key: "audit_export", enabled: true, limit: null }],
    });
    let fail = true;
    const original = store.insertSnapshot.bind(store);
    store.insertSnapshot = async (row) => {
      if (fail) throw new Error("snapshot down");
      return original(row);
    };
    await expect(service.assign(operator, assignment(revisionId))).rejects.toThrow("snapshot down");
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBeNull();
    expect(store.snapshots).toHaveLength(0);
    fail = false;
    const recovered = await service.assign(operator, assignment(revisionId));
    expect(recovered.content.projectionLabel).toBe("待交付");
    expect(recovered.features).toEqual([{ key: "audit_export", enabled: true, limit: null }]);
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(revisionId);
    expect(store.snapshots).toHaveLength(1);
  });

  test("增量授权写入后解析失败，同一幂等键重试不会再插入一条", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, {
      id: revisionId, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["read"], aiActions: [], features: [],
    });
    await service.assign(operator, assignment(revisionId));
    let fail = true;
    const original = store.insertSnapshot.bind(store);
    store.insertSnapshot = async (row) => {
      if (fail) throw new Error("snapshot down");
      return original(row);
    };
    const grant: GrantContentCollection = {
      workspaceSlug: "team", label: "夹具专题", collections: [{ key: "fixture_topic", label: "夹具专题" }],
      actions: ["cite"], effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: null,
      reason: "增加夹具专题", idempotencyKey: "grant-retry-001",
    };
    await expect(service.grant(operator, grant)).rejects.toThrow("snapshot down");
    expect(store.grantRows).toHaveLength(1);
    fail = false;
    const recovered = await service.grant(operator, grant);
    expect(recovered.content.collections.map((item) => item.key)).toEqual(["fixture_core", "fixture_topic"]);
    expect(store.grantRows).toHaveLength(1);
  });

  test("读取会在增量授权生效或到期后写入新快照", async () => {
    const store = new MemoryStore();
    workspace(store);
    let now = new Date("2026-09-24T00:00:00.000Z");
    const service = new ProductEntitlementService(store, () => now);
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, {
      id: revisionId, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["read"], aiActions: [], features: [],
    });
    store.items.set("workspace:team", { ...store.items.get("workspace:team")!, effectiveUntil: "2026-12-01T00:00:00.000Z" });
    await service.assign(operator, assignment(revisionId));
    const upcoming: GrantContentCollection = {
      workspaceSlug: "team", label: "尚未开始", collections: [{ key: "fixture_later", label: "稍后专题" }],
      actions: ["cite"], effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-11-01T00:00:00.000Z",
      reason: "稍后开放", idempotencyKey: "grant-later-001",
    };
    const hidden = await service.grant(operator, upcoming);
    expect(hidden.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    expect(hidden.content.projectionLabel).toBe("待交付");
    now = new Date("2026-10-15T00:00:00.000Z");
    const started = await service.getForCustomer("lawyer", "team");
    expect(started.content.collections.map((item) => item.key)).toEqual(["fixture_core", "fixture_later"]);
    expect(started.content.projectionLabel).toBe("待交付");
    expect(started.revision).toBeGreaterThan(hidden.revision);
    expect(store.snapshots.find((item) => item.revision === hidden.revision)?.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    store.grantRows[0]!.effectiveUntil = "2026-10-02T00:00:00.000Z";
    const ended = await service.getForCustomer("lawyer", "team");
    expect(ended.content.collections.map((item) => item.key)).toEqual(["fixture_core"]);
    expect(ended.content.projectionLabel).toBe("待交付");
    expect(ended.ai.consumableAllowance).toBeNull();
    expect(store.snapshots.find((item) => item.revision === started.revision)?.collections.map((item) => item.key)).toEqual(["fixture_core", "fixture_later"]);
  });

  test("重放旧分配不会退回产品版本，未绑定的崩溃可以补绑", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const olderId = "product_plan_revision:fixture:1";
    const newerId = "product_plan_revision:fixture:2";
    for (const [id, revision] of [[olderId, 1], [newerId, 2]] as const) {
      store.revisions.set(id, {
        id, planKey: "fixture_plus", planName: "夹具律师 Plus", revision,
        collections: [{ key: revision === 1 ? "fixture_core" : "fixture_expanded", label: revision === 1 ? "夹具核心" : "夹具扩展" }],
        actions: ["read"], aiActions: [], features: [],
      });
    }
    let failBind = true;
    const original = store.bindProductRevision.bind(store);
    store.bindProductRevision = async (itemId, productPlanRevisionId) => {
      if (failBind) throw new Error("bind down");
      return original(itemId, productPlanRevisionId);
    };
    await expect(service.assign(operator, assignment(olderId))).rejects.toThrow("bind down");
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBeNull();
    failBind = false;
    const first = await service.assign(operator, assignment(olderId));
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(olderId);
    await service.assign(operator, { ...assignment(newerId), idempotencyKey: "assign-team-0002", reason: "升级夹具版本" });
    const replay = await service.assign(operator, assignment(olderId));
    expect(replay.revision).toBe(first.revision);
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(newerId);
  });

  test("新分配快照已写入但绑定失败时，重试会绑上新版本", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const olderId = "product_plan_revision:fixture:1";
    const newerId = "product_plan_revision:fixture:2";
    for (const [id, revision] of [[olderId, 1], [newerId, 2]] as const) {
      store.revisions.set(id, {
        id, planKey: "fixture_plus", planName: "夹具律师 Plus", revision,
        collections: [{ key: revision === 1 ? "fixture_core" : "fixture_expanded", label: revision === 1 ? "夹具核心" : "夹具扩展" }],
        actions: ["read"], aiActions: [], features: [],
      });
    }
    await service.assign(operator, assignment(olderId));
    let failBind = true;
    const original = store.bindProductRevision.bind(store);
    store.bindProductRevision = async (itemId, productPlanRevisionId) => {
      if (failBind) throw new Error("bind down");
      return original(itemId, productPlanRevisionId);
    };
    const newer = { ...assignment(newerId), idempotencyKey: "assign-team-0002", reason: "升级夹具版本" };
    await expect(service.assign(operator, newer)).rejects.toThrow("bind down");
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(olderId);
    expect(store.snapshots.some((item) => item.productPlanRevisionId === newerId)).toBe(true);
    failBind = false;
    await service.assign(operator, newer);
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(newerId);
  });

  test("绑定失败后读取出的空快照仍允许同一幂等键补绑", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const revisionId = "product_plan_revision:fixture:1";
    store.revisions.set(revisionId, {
      id: revisionId, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
      collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["read"], aiActions: [], features: [],
    });
    let failBind = true;
    const original = store.bindProductRevision.bind(store);
    store.bindProductRevision = async (itemId, productPlanRevisionId) => {
      if (failBind) throw new Error("bind down");
      return original(itemId, productPlanRevisionId);
    };
    await expect(service.assign(operator, assignment(revisionId))).rejects.toThrow("bind down");
    const read = await service.getForCustomer("lawyer", "team");
    expect(read.summary).toBe("无有效内容授权");
    expect(read.baseSource.planKey).toBeNull();
    expect(read.revision).toBe(0);
    expect(store.snapshots[0]!.revision).toBeGreaterThan(read.revision);
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBeNull();
    failBind = false;
    await service.assign(operator, assignment(revisionId));
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(revisionId);
  });

  test("已绑定的新版本在空快照之后不会被旧分配退回", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const olderId = "product_plan_revision:fixture:1";
    const newerId = "product_plan_revision:fixture:2";
    for (const [id, revision] of [[olderId, 1], [newerId, 2]] as const) {
      store.revisions.set(id, {
        id, planKey: "fixture_plus", planName: "夹具律师 Plus", revision,
        collections: [{ key: revision === 1 ? "fixture_core" : "fixture_expanded", label: revision === 1 ? "夹具核心" : "夹具扩展" }],
        actions: ["read"], aiActions: [], features: [],
      });
    }
    await service.assign(operator, assignment(olderId));
    await service.assign(operator, { ...assignment(newerId), idempotencyKey: "assign-team-0002", reason: "升级夹具版本" });
    store.items.set("workspace:team", { ...store.items.get("workspace:team")!, effectiveUntil: "2026-09-02T00:00:00.000Z" });
    const read = await service.getForCustomer("lawyer", "team");
    expect(read.summary).toBe("无有效内容授权");
    expect(read.baseSource.planKey).toBeNull();
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(newerId);
    await service.assign(operator, assignment(olderId));
    expect(store.items.get("workspace:team")?.productPlanRevisionId).toBe(newerId);
  });

  test("恢复旧产品版本不会把已发布头退回去", async () => {
    const store = new MemoryStore();
    workspace(store);
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    // 修订行内容必须与发布请求体一致（同号重发要求幂等匹配）；rev1/rev2 仅 collections 不同。
    store.insertProductRevision = async (input) => {
      const id = `product_plan_revision:${input.planId}:${input.revision}`;
      store.revisions.set(id, {
        id, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: input.revision,
        collections: [input.revision === 1 ? { key: "fixture_core", label: "夹具核心" } : { key: "fixture_expanded", label: "夹具扩展" }],
        actions: ["browse", "search", "read"], aiActions: ["research"],
        features: [{ key: "audit_export", enabled: true, limit: null }],
      });
      return id;
    };
    const first = await service.publishRevision(operator, publishBody(1, "fixture_core", "夹具核心"));
    const second = await service.publishRevision(operator, publishBody(2, "fixture_expanded", "夹具扩展"));
    const plan = store.plans.get("fixture_plus");
    expect(plan?.active).toBe(second.productPlanRevisionId);
    store.audits = store.audits.filter((item) => item.idempotencyKey !== "publish-1-key");
    const recovered = await service.publishRevision(operator, publishBody(1, "fixture_core", "夹具核心"));
    expect(recovered.productPlanRevisionId).toBe(first.productPlanRevisionId);
    expect(plan?.active).toBe(second.productPlanRevisionId);
    const otherKey = await service.publishRevision(operator, { ...publishBody(1, "fixture_core", "夹具核心"), idempotencyKey: "publish-1-other" });
    expect(otherKey.productPlanRevisionId).toBe(first.productPlanRevisionId);
    expect(plan?.active).toBe(second.productPlanRevisionId);
  });

  test("增量授权的存储顺序不改变摘要", () => {
    const subscription: SubscriptionFact = {
      itemId: "quota_subscription_item:team", status: "active", effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveUntil: "2026-10-01T00:00:00.000Z", productPlanRevisionId: "product_plan_revision:1",
      subscriptionId: "quota_subscription:team", billingAccountKey: "acct-a", subscriptionStatus: "active",
    };
    const productRevision: ProductRevisionBody = {
      id: "product_plan_revision:1", planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
      collections: [], actions: [], aiActions: [], features: [],
    };
    const grant = (id: string): ContentGrantFact => ({
      id, label: id, collections: [{ key: id, label: id }], actions: ["cite"],
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: null,
    });
    const facts = {
      now: "2026-09-24T00:00:00.000Z",
      subscription,
      productRevision,
    };
    const forward = resolveEntitlement({ ...facts, grants: [grant("content_grant:b"), grant("content_grant:a")] });
    const reverse = resolveEntitlement({ ...facts, grants: [grant("content_grant:a"), grant("content_grant:b")] });
    expect(forward.digest).toBe(reverse.digest);
    expect(forward.sources.map((item) => item.sourceId)).toEqual(["quota_subscription:team", "content_grant:a", "content_grant:b"]);
  });
});

function assignment(productPlanRevisionId: string): AssignProductEntitlement {
  return {
    workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId,
    reason: "为夹具工作区开通", idempotencyKey: "assign-team-0001",
  };
}

describe("refreshSubscriptionDriven（LCA08 订阅级联）", () => {
  function lifecycleStore(): MemoryStore {
    const store = new MemoryStore();
    workspace(store);
    store.dbNames.set("workspace:team", "ws_team");
    const remember = store.insertProductRevision.bind(store);
    store.insertProductRevision = async (input) => {
      const id = `product_plan_revision:${input.planId}:${input.revision}`;
      store.pendingRevision.set(id, {
        planKey: "fixture_plus", planName: "夹具律师 Plus", revision: input.revision,
        collections: [{ key: "fixture_core", label: "夹具核心" }],
        actions: ["browse", "search", "read"], aiActions: ["research"],
        features: [
          { key: "audit_export", enabled: true, limit: null },
          { key: "ai_cycle_allowance", enabled: input.revision > 0, limit: 200 },
        ],
      });
      return remember(input);
    };
    return store;
  }

  function publishWithAllowance(revision: number, key: string, label: string, limit: number | null): PublishProductRevision {
    return {
      ...publishBody(revision, key, label),
      features: [
        { key: "audit_export", enabled: true, limit: null },
        { key: "ai_cycle_allowance", enabled: limit !== null, limit },
      ],
      idempotencyKey: `publish-${revision}-allowance`,
    };
  }

  test("事实未变时 digest 幂等不新建快照，并给出周期额度指令", async () => {
    const store = lifecycleStore();
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const published = await service.publishRevision(operator, publishWithAllowance(1, "fixture_core", "夹具核心", 200));
    await service.assign(operator, assignment(published.productPlanRevisionId));

    const first = await service.refreshSubscriptionDriven("workspace:team", { correlationId: "lifecycle-1" });
    expect(first.changed).toBe(false);
    expect(store.snapshots).toHaveLength(1);
    expect(first.planCycle).toMatchObject({
      workspaceDb: "ws_team",
      usable: true,
      cycleAllowance: 200,
      expiresAt: "2026-10-01T00:00:00.000Z",
    });
    expect(first.planCycle?.periodKey).toContain("quota_subscription:team");

    const repeat = await service.refreshSubscriptionDriven("workspace:team", { correlationId: "lifecycle-2" });
    expect(repeat.changed).toBe(false);
    expect(repeat.planCycle).toEqual(first.planCycle);
    expect(store.snapshots).toHaveLength(1);
  });

  test("事实变化（新增授权）时追加快照并移动指针", async () => {
    const store = lifecycleStore();
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const published = await service.publishRevision(operator, publishWithAllowance(1, "fixture_core", "夹具核心", 200));
    await service.assign(operator, assignment(published.productPlanRevisionId));

    const before = await service.getForCustomer("lawyer", "team");
    store.insertGrant("workspace:team", {
      id: "", label: "临时授权", collections: [{ id: "c1", key: "fixture_bonus", label: "追加集" }],
      actions: ["cite"], effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: null,
      reason: "投放补偿", actor: "ops", idempotencyKey: "grant-1",
    });

    const refreshed = await service.refreshSubscriptionDriven("workspace:team", { correlationId: "lifecycle-3" });
    expect(refreshed.changed).toBe(true);
    expect(store.snapshots).toHaveLength(2);
    const after = await service.getForCustomer("lawyer", "team");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.content.collections.map((item) => item.key)).toContain("fixture_bonus");
    expect(refreshed.planCycle?.cycleAllowance).toBe(200);
  });

  test("订阅到期后快照变为无有效内容授权，周期额度指令消失", async () => {
    const store = lifecycleStore();
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const published = await service.publishRevision(operator, publishWithAllowance(1, "fixture_core", "夹具核心", 200));
    await service.assign(operator, assignment(published.productPlanRevisionId));

    store.items.set("workspace:team", {
      ...store.items.get("workspace:team")!,
      subscriptionStatus: "expired",
      effectiveUntil: "2026-09-20T00:00:00.000Z",
    });
    const refreshed = await service.refreshSubscriptionDriven("workspace:team", { correlationId: "lifecycle-4" });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.planCycle).toBeNull();
    const view = await service.getForCustomer("lawyer", "team");
    expect(view.baseSource.kind).toBe("none");
    expect(view.content.collections).toHaveLength(0);
  });

  test("恢复到既有 digest 时回指旧快照而不重复建快照", async () => {
    const store = lifecycleStore();
    const service = new ProductEntitlementService(store, () => new Date("2026-09-24T00:00:00.000Z"));
    const published = await service.publishRevision(operator, publishWithAllowance(1, "fixture_core", "夹具核心", 200));
    await service.assign(operator, assignment(published.productPlanRevisionId));
    const originalSnapshot = store.snapshots[0]!;

    // 到期 → none 快照
    store.items.set("workspace:team", {
      ...store.items.get("workspace:team")!,
      subscriptionStatus: "expired",
      effectiveUntil: "2026-09-20T00:00:00.000Z",
    });
    await service.refreshSubscriptionDriven("workspace:team", { correlationId: "lifecycle-5" });
    expect(store.snapshots).toHaveLength(2);

    // 续订恢复到与最初完全相同的窗口与产品（digest 一致）→ 回指旧快照
    store.items.set("workspace:team", {
      ...store.items.get("workspace:team")!,
      subscriptionStatus: "active",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveUntil: "2026-10-01T00:00:00.000Z",
    });
    const restored = await service.refreshSubscriptionDriven("workspace:team", { correlationId: "lifecycle-6" });
    expect(restored.changed).toBe(true);
    expect(store.snapshots).toHaveLength(2);
    const view = await service.getForCustomer("lawyer", "team");
    expect(view.revision).toBe(originalSnapshot.revision);
    expect(restored.planCycle?.periodKey).toContain("2026-09-01");
  });
});
