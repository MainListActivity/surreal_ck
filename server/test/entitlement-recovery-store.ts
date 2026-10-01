// LCA13 测试夹具：产品权益子系统的内存 store 与常用 fixture，供
// product-entitlement/recovery.test.ts 与 routes/product-entitlement.test.ts 共用。
import type { GrantContentCollection } from "@surreal-ck/shared";
import type { ContentGrantFact, ProductRevisionBody, ResourceFact, SubscriptionFact } from "../src/product-entitlement/resolve";
import type { AuditRecord, GrantFactRow, ProductActor, ProductEntitlementStore, SnapshotRecord, WorkspaceRef, WorkspaceRuntimeRef } from "../src/product-entitlement/service";

type GrantRow = ContentGrantFact & {
  reason: string | null;
  actor: string | null;
  idempotencyKey: string | null;
};

export class EntitlementRecoveryStore implements ProductEntitlementStore {
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
    // 同步检查+写入，模拟唯一索引的原子冲突（不能先 await 再 push，否则并发双写）。
    if (this.audits.some((item) => item.actor === row.actor && item.idempotencyKey === row.idempotencyKey)) return "conflict";
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

/** 标准夹具工作区：活跃订阅 + plus 资源已同步。 */
export function seedWorkspace(store: EntitlementRecoveryStore, overrides: Partial<SubscriptionFact> = {}) {
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

export const operator: ProductActor = { subject: "ops", capabilities: ["quota.read", "subscription.manage", "entitlement.gift", "entitlement.repair"] };

export function fixtureRevision(id = "product_plan_revision:fixture:1"): ProductRevisionBody {
  return {
    id, planKey: "fixture_plus", planName: "夹具律师 Plus", revision: 1,
    collections: [{ key: "fixture_core", label: "夹具核心" }], actions: ["read"], aiActions: [], features: [],
  };
}

export function fixtureAssignment(revisionId: string) {
  return { workspaceSlug: "team", billingAccountKey: "acct-a", productPlanRevisionId: revisionId, reason: "为夹具工作区开通", idempotencyKey: "assign-team-0001" };
}

export function fixtureGrantBody(overrides: Partial<GrantContentCollection> = {}): GrantContentCollection {
  return {
    workspaceSlug: "team", label: "临时赠送夹具", collections: [{ key: "fixture_gift", label: "赠送夹具" }],
    actions: ["read", "cite"], effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-09-30T00:00:00.000Z",
    reason: "客户支持赠送", idempotencyKey: "gift-team-0001", ...overrides,
  };
}
