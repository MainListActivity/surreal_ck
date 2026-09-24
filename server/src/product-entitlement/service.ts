import type {
  AssignProductEntitlement,
  GrantContentCollection,
  ProductEntitlementView,
  PublishProductRevision,
} from "@surreal-ck/shared";
import { resolveEntitlement, toView, type ContentGrantFact, type EntitlementDraft, type ProductRevisionBody, type ResourceFact, type SubscriptionFact } from "./resolve";

export class ProductEntitlementError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "cross_account" | "no_subscription" | "conflict" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "ProductEntitlementError";
  }
}

export type ProductActor = { subject: string; capabilities: readonly string[] };

export type WorkspaceRef = { id: string; slug: string };
export type SnapshotRecord = EntitlementDraft & { id: string; workspaceId: string; workspaceSlug: string; revision: number };
export type AuditRecord = {
  action: "publish" | "assign" | "grant";
  requestDigest: string;
  entitlementId: string | null;
  productPlanRevisionId: string | null;
};

export interface ProductEntitlementStore {
  workspaceBySlug(slug: string): Promise<WorkspaceRef | null>;
  membership(subject: string, workspaceId: string): Promise<"admin" | "participant" | null>;
  activeItem(workspaceId: string): Promise<SubscriptionFact | null>;
  bindProductRevision(itemId: string, productPlanRevisionId: string): Promise<void>;
  productRevision(id: string): Promise<ProductRevisionBody | null>;
  resourceTemplateExists(id: string): Promise<boolean>;
  upsertCollection(key: string, label: string): Promise<{ id: string; key: string; label: string }>;
  insertContentTemplate(actor: string, collections: { id: string; key: string; label: string }[], actions: string[]): Promise<string>;
  insertAiTemplate(actor: string, actions: string[]): Promise<string>;
  insertFeatureTemplate(actor: string, features: ProductRevisionBody["features"]): Promise<string>;
  upsertPlan(planKey: string, displayName: string): Promise<string>;
  productRevisionId(planId: string, revision: number): Promise<string | null>;
  insertProductRevision(input: {
    planId: string;
    revision: number;
    resourceTemplateId: string;
    contentTemplateId: string;
    aiTemplateId: string;
    featureTemplateId: string;
    actor: string;
    correlationId: string;
  }): Promise<string | null>;
  setActiveRevision(planId: string, revisionId: string): Promise<void>;
  grants(workspaceId: string): Promise<ContentGrantFact[]>;
  insertGrant(workspaceId: string, grant: Omit<ContentGrantFact, "id" | "collections"> & {
    collections: { id: string; key: string; label: string }[];
    reason: string;
    actor: string;
    idempotencyKey: string;
  }): Promise<string | null>;
  currentSnapshot(workspaceId: string): Promise<SnapshotRecord | null>;
  snapshotById(id: string): Promise<SnapshotRecord | null>;
  snapshotByDigest(workspaceId: string, digest: string): Promise<SnapshotRecord | null>;
  newestSnapshotRevision(workspaceId: string, productPlanRevisionId: string): Promise<number | null>;
  insertSnapshot(row: SnapshotRecord): Promise<"ok" | "conflict">;
  pointWorkspace(workspaceId: string, snapshotId: string): Promise<void>;
  auditByKey(actor: string, idempotencyKey: string): Promise<AuditRecord | null>;
  insertAudit(row: AuditRecord & { actor: string; idempotencyKey: string; reason: string; workspaceId: string | null }): Promise<"ok" | "conflict">;
  attachAuditEntitlement(actor: string, idempotencyKey: string, entitlementId: string): Promise<"ok" | "conflict">;
  resourceStatus(workspaceId: string): Promise<ResourceFact>;
}

function denyUnless(actor: ProductActor, capability: string): void {
  if (!actor.capabilities.includes(capability)) throw new ProductEntitlementError("forbidden", "缺少运营能力");
}

function digestOf(value: unknown): string {
  return JSON.stringify(value);
}

function assertActions(actions: readonly string[]): void {
  if (new Set(actions).size !== actions.length) throw new ProductEntitlementError("invalid_request", "动作重复");
}

export class ProductEntitlementService {
  constructor(private readonly store: ProductEntitlementStore, private readonly now: () => Date = () => new Date()) {}

  async publishRevision(actor: ProductActor, input: PublishProductRevision): Promise<{ productPlanRevisionId: string }> {
    denyUnless(actor, "subscription.manage");
    assertActions(input.actions);
    assertActions(input.aiActions);
    const requestDigest = digestOf(input);
    const prior = await this.store.auditByKey(actor.subject, input.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest || !prior.productPlanRevisionId) throw new ProductEntitlementError("conflict", "幂等键已用于其他请求");
      return { productPlanRevisionId: prior.productPlanRevisionId };
    }
    if (!(await this.store.resourceTemplateExists(input.resourceTemplateId))) {
      throw new ProductEntitlementError("invalid_request", "资源模板不存在");
    }
    const planId = await this.store.upsertPlan(input.planKey, input.displayName);
    const existing = await this.store.productRevisionId(planId, input.revision);
    if (existing) return await this.finishPublish(actor, input.reason, input.idempotencyKey, requestDigest, planId, existing);
    const collections = [];
    for (const collection of input.collections) collections.push(await this.store.upsertCollection(collection.key, collection.label));
    const created = await this.store.insertProductRevision({
      planId,
      revision: input.revision,
      resourceTemplateId: input.resourceTemplateId,
      contentTemplateId: await this.store.insertContentTemplate(actor.subject, collections, input.actions),
      aiTemplateId: await this.store.insertAiTemplate(actor.subject, input.aiActions),
      featureTemplateId: await this.store.insertFeatureTemplate(actor.subject, input.features),
      actor: actor.subject,
      correlationId: input.idempotencyKey,
    });
    const revisionId = created ?? await this.store.productRevisionId(planId, input.revision);
    if (!revisionId) throw new ProductEntitlementError("conflict", "产品版本已存在");
    return await this.finishPublish(actor, input.reason, input.idempotencyKey, requestDigest, planId, revisionId);
  }

  async assign(actor: ProductActor, input: AssignProductEntitlement): Promise<ProductEntitlementView> {
    denyUnless(actor, "subscription.manage");
    const requestDigest = digestOf(input);
    const workspace = await this.requireWorkspace(input.workspaceSlug);
    const item = await this.store.activeItem(workspace.id);
    if (!item || item.status !== "active") throw new ProductEntitlementError("no_subscription", "工作区没有可绑定的有效订阅");
    if (item.billingAccountKey !== input.billingAccountKey) throw new ProductEntitlementError("cross_account", "订阅不属于该计费账户");
    const revision = await this.store.productRevision(input.productPlanRevisionId);
    if (!revision) throw new ProductEntitlementError("invalid_request", "产品版本不存在");
    const replay = await this.claim(actor, "assign", input.reason, input.idempotencyKey, requestDigest, workspace.id, revision.id);
    if (replay) {
      await this.bindReplay(workspace.id, revision.id, replay.revision);
      return replay;
    }
    const materialized = await this.materialize(workspace, input.idempotencyKey, revision);
    await this.store.attachAuditEntitlement(actor.subject, input.idempotencyKey, materialized.snapshot.id);
    await this.bindAssigned(workspace.id, revision.id);
    return (await this.storedView(actor.subject, input.idempotencyKey, requestDigest)) ?? materialized.view;
  }

  async grant(actor: ProductActor, input: GrantContentCollection): Promise<ProductEntitlementView> {
    denyUnless(actor, "subscription.manage");
    if (input.effectiveUntil && input.effectiveUntil <= input.effectiveFrom) {
      throw new ProductEntitlementError("invalid_request", "增量授权的结束时间必须晚于开始时间");
    }
    const requestDigest = digestOf(input);
    const workspace = await this.requireWorkspace(input.workspaceSlug);
    const replay = await this.claim(actor, "grant", input.reason, input.idempotencyKey, requestDigest, workspace.id, null);
    if (replay) return replay;
    const collections = [];
    for (const collection of input.collections) collections.push(await this.store.upsertCollection(collection.key, collection.label));
    const grantId = await this.store.insertGrant(workspace.id, {
      label: input.label, collections, actions: input.actions,
      effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil, reason: input.reason, actor: actor.subject,
      idempotencyKey: input.idempotencyKey,
    });
    if (!grantId) throw new ProductEntitlementError("conflict", "增量授权已存在");
    const materialized = await this.materialize(workspace, input.idempotencyKey);
    await this.store.attachAuditEntitlement(actor.subject, input.idempotencyKey, materialized.snapshot.id);
    return (await this.storedView(actor.subject, input.idempotencyKey, requestDigest)) ?? materialized.view;
  }

  async getForOperator(actor: ProductActor, workspaceSlug: string): Promise<ProductEntitlementView> {
    denyUnless(actor, "quota.read");
    const workspace = await this.requireWorkspace(workspaceSlug);
    return this.viewFor(workspace);
  }

  async getForCustomer(subject: string, workspaceSlug: string): Promise<ProductEntitlementView> {
    const workspace = await this.store.workspaceBySlug(workspaceSlug);
    if (!workspace || !(await this.store.membership(subject, workspace.id))) {
      throw new ProductEntitlementError("not_found", "工作区不存在或不可访问");
    }
    return this.viewFor(workspace);
  }

  private async requireWorkspace(slug: string): Promise<WorkspaceRef> {
    const workspace = await this.store.workspaceBySlug(slug);
    if (!workspace) throw new ProductEntitlementError("not_found", "工作区不存在");
    return workspace;
  }

  private async finishPublish(
    actor: ProductActor,
    reason: string,
    idempotencyKey: string,
    requestDigest: string,
    planId: string,
    revisionId: string,
  ): Promise<{ productPlanRevisionId: string }> {
    await this.store.setActiveRevision(planId, revisionId);
    const audit = await this.store.insertAudit({
      actor: actor.subject, action: "publish", reason, idempotencyKey, requestDigest,
      entitlementId: null, productPlanRevisionId: revisionId, workspaceId: null,
    });
    if (audit === "conflict") {
      const prior = await this.store.auditByKey(actor.subject, idempotencyKey);
      if (!prior || prior.requestDigest !== requestDigest || !prior.productPlanRevisionId) {
        throw new ProductEntitlementError("conflict", "幂等键已用于其他请求");
      }
      return { productPlanRevisionId: prior.productPlanRevisionId };
    }
    return { productPlanRevisionId: revisionId };
  }

  private async claim(
    actor: ProductActor,
    action: "assign" | "grant",
    reason: string,
    idempotencyKey: string,
    requestDigest: string,
    workspaceId: string,
    productPlanRevisionId: string | null,
  ): Promise<ProductEntitlementView | null> {
    const ready = await this.storedView(actor.subject, idempotencyKey, requestDigest);
    if (ready) return ready;
    const prior = await this.store.auditByKey(actor.subject, idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new ProductEntitlementError("conflict", "幂等键已用于其他请求");
      return null;
    }
    const wrote = await this.store.insertAudit({
      actor: actor.subject, action, reason, idempotencyKey, requestDigest, workspaceId,
      entitlementId: null, productPlanRevisionId,
    });
    if (wrote === "ok") return null;
    const replay = await this.storedView(actor.subject, idempotencyKey, requestDigest);
    if (replay) return replay;
    const again = await this.store.auditByKey(actor.subject, idempotencyKey);
    if (!again || again.requestDigest !== requestDigest) throw new ProductEntitlementError("conflict", "幂等键已用于其他请求");
    return null;
  }

  private async storedView(actor: string, idempotencyKey: string, requestDigest: string): Promise<ProductEntitlementView | null> {
    const prior = await this.store.auditByKey(actor, idempotencyKey);
    if (!prior) return null;
    if (prior.requestDigest !== requestDigest) throw new ProductEntitlementError("conflict", "幂等键已用于其他请求");
    if (!prior.entitlementId) return null;
    const snapshot = await this.store.snapshotById(prior.entitlementId);
    if (!snapshot) throw new ProductEntitlementError("conflict", "原权益快照不存在");
    const resource = await this.store.resourceStatus(snapshot.workspaceId);
    return toView(snapshot.workspaceSlug, snapshot.revision, snapshot, resource);
  }

  private async bindAssigned(workspaceId: string, productPlanRevisionId: string): Promise<void> {
    const item = await this.store.activeItem(workspaceId);
    if (!item || item.status !== "active" || item.productPlanRevisionId === productPlanRevisionId) return;
    await this.store.bindProductRevision(item.itemId, productPlanRevisionId);
  }

  private async bindReplay(workspaceId: string, productPlanRevisionId: string, snapshotRevision: number): Promise<void> {
    const item = await this.store.activeItem(workspaceId);
    if (item?.productPlanRevisionId && item.productPlanRevisionId !== productPlanRevisionId) {
      const established = await this.store.newestSnapshotRevision(workspaceId, item.productPlanRevisionId);
      if (established === null || snapshotRevision <= established) return;
    }
    await this.bindAssigned(workspaceId, productPlanRevisionId);
  }

  private async viewFor(workspace: WorkspaceRef): Promise<ProductEntitlementView> {
    const current = await this.store.currentSnapshot(workspace.id);
    const draft = await this.draftFor(workspace);
    if (current && current.digest !== draft.digest) return (await this.materialize(workspace, "read")).view;
    const resource = await this.store.resourceStatus(workspace.id);
    if (current) return toView(workspace.slug, current.revision, current, resource);
    return toView(workspace.slug, 0, draft, resource);
  }

  private async materialize(
    workspace: WorkspaceRef,
    causationId: string,
    revisionOverride?: ProductRevisionBody,
  ): Promise<{ view: ProductEntitlementView; snapshot: SnapshotRecord }> {
    const draft = await this.draftFor(workspace, revisionOverride);
    const resource = await this.store.resourceStatus(workspace.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const same = await this.store.snapshotByDigest(workspace.id, draft.digest);
      if (same) {
        await this.store.pointWorkspace(workspace.id, same.id);
        return { snapshot: same, view: toView(workspace.slug, same.revision, same, resource) };
      }
      const current = await this.store.currentSnapshot(workspace.id);
      const revision = (current?.revision ?? 0) + 1;
      const row: SnapshotRecord = {
        ...draft, id: "", workspaceId: workspace.id, workspaceSlug: workspace.slug, revision, correlationId: causationId,
      };
      const inserted = await this.store.insertSnapshot(row);
      if (inserted === "ok") {
        const saved = await this.store.snapshotByDigest(workspace.id, draft.digest);
        if (!saved) throw new ProductEntitlementError("conflict", "权益快照没有写上");
        await this.store.pointWorkspace(workspace.id, saved.id);
        return { snapshot: saved, view: toView(workspace.slug, saved.revision, saved, resource) };
      }
    }
    throw new ProductEntitlementError("conflict", "权益解析发生并发冲突");
  }

  private async draftFor(workspace: WorkspaceRef, revisionOverride?: ProductRevisionBody): Promise<EntitlementDraft> {
    const subscription = await this.store.activeItem(workspace.id);
    const subscriptionForResolve = subscription && revisionOverride
      ? { ...subscription, productPlanRevisionId: revisionOverride.id }
      : subscription;
    const productRevision = revisionOverride
      ?? (subscription?.productPlanRevisionId ? await this.store.productRevision(subscription.productPlanRevisionId) : null);
    return resolveEntitlement({
      now: this.now().toISOString(),
      subscription: subscriptionForResolve,
      productRevision,
      grants: await this.store.grants(workspace.id),
    });
  }
}
