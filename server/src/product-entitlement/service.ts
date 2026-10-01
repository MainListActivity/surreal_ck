import type {
  AssignProductEntitlement,
  DeliveryRepairResult,
  EntitlementExceptionItem,
  GrantContentCollection,
  ProductEntitlementView,
  ProjectionVerification,
  PublishProductRevision,
  RevokeContentGrant,
  RepairContentDelivery,
} from "@surreal-ck/shared";
import type { PlanCycleDirective } from "../ai-allowance/plan-cycle";
import { planCycleDirective } from "../ai-allowance/plan-cycle";
import type { AiAllowanceOpsStatus } from "../ai-allowance/ops-status";
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
/** 订阅生命周期刷新需要 workspace 的 runtime 数据库名来触达 AI 额度账本。 */
export type WorkspaceRuntimeRef = WorkspaceRef & { dbName: string };
export type SnapshotRecord = EntitlementDraft & { id: string; workspaceId: string; workspaceSlug: string; revision: number };
export type AuditRecord = {
  action: "publish" | "assign" | "grant" | "revoke" | "repair";
  requestDigest: string;
  entitlementId: string | null;
  productPlanRevisionId: string | null;
};

/** LCA13：运营解释用的完整赠送事实（含撤销状态与理由）。 */
export type GrantFactRow = ContentGrantFact & {
  reason: string | null;
  operatorSubject: string | null;
  idempotencyKey: string | null;
  revoked: boolean;
  revokeReason?: string | null;
};

export interface ProductEntitlementStore {
  workspaceBySlug(slug: string): Promise<WorkspaceRef | null>;
  workspaceById(id: string): Promise<WorkspaceRuntimeRef | null>;
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
  grantFacts(workspaceId: string): Promise<GrantFactRow[]>;
  grantById(workspaceId: string, grantId: string): Promise<GrantFactRow | null>;
  insertGrantRevocation(workspaceId: string, grantId: string, reason: string, actor: string, idempotencyKey: string): Promise<"ok" | "replayed" | "conflict">;
  deliveryCandidates(limit: number, offset: number): Promise<WorkspaceRuntimeRef[]>;
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

/**
 * 同号重发的幂等语义：产品修订一经发布不可变。请求体与既有修订内容完全一致才算重放
 * （幂等返回既有 id）；任何内容差异都是冲突，必须报错——绝不能静默返回旧修订，
 * 否则运营会以为新内容（如 aiActions）已生效（LCA05 生产实测踩坑）。
 */
function sameRevisionContent(current: ProductRevisionBody, input: PublishProductRevision): boolean {
  const signatureOf = (values: readonly string[]): string =>
    JSON.stringify([...new Set(values)].sort());
  const featureSignature = (features: { key: string; enabled: boolean; limit: number | null }[]): string =>
    signatureOf(features.map((feature) => `${feature.key}\u0000${feature.enabled}\u0000${feature.limit ?? "null"}`));
  const collectionSignature = (collections: { key: string; label: string }[]): string =>
    signatureOf(collections.map((collection) => `${collection.key}\u0000${collection.label}`));
  return current.planKey === input.planKey
    && current.planName === input.displayName
    && current.revision === input.revision
    && signatureOf(current.actions) === signatureOf(input.actions)
    && signatureOf(current.aiActions) === signatureOf(input.aiActions)
    && featureSignature(current.features) === featureSignature(input.features)
    && collectionSignature(current.collections) === collectionSignature(input.collections);
}

function assertActions(actions: readonly string[]): void {
  if (new Set(actions).size !== actions.length) throw new ProductEntitlementError("invalid_request", "动作重复");
}

export class ProductEntitlementService {
  constructor(
    private readonly store: ProductEntitlementStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ops?: {
      /** LCA13：AI 预留/结算状态（按 workspace db 名读取真实账本事实）。 */
      aiStatus?: (dbName: string) => Promise<AiAllowanceOpsStatus | null>;
      /** LCA13：内容投影核验（与 reader gate 同款受限会话，运营无额外权力）。 */
      projectionVerify?: (collections: { key: string; label: string }[]) => Promise<ProjectionVerification | null>;
      /** LCA13：plan-cycle 指令幂等同步（修复重试顺带重驱，不新增授予语义）。 */
      syncPlanCycle?: (directive: PlanCycleDirective, correlationId: string) => Promise<void>;
    },
  ) {}

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
    if (existing) {
      const current = await this.store.productRevision(existing);
      if (!current || !sameRevisionContent(current, input)) {
        throw new ProductEntitlementError("conflict", "产品版本已存在且内容不一致，请发布新的版本号");
      }
      return await this.finishPublish(actor, input.reason, input.idempotencyKey, requestDigest, planId, existing);
    }
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
    if (!created) {
      // 并发竞争：同号修订刚被并排请求写入；同样必须内容一致才认幂等。
      const raced = await this.store.productRevisionId(planId, input.revision);
      const current = raced ? await this.store.productRevision(raced) : null;
      if (!raced || !current || !sameRevisionContent(current, input)) {
        throw new ProductEntitlementError("conflict", "产品版本已存在且内容不一致，请发布新的版本号");
      }
      return await this.finishPublish(actor, input.reason, input.idempotencyKey, requestDigest, planId, raced);
    }
    return await this.finishPublish(actor, input.reason, input.idempotencyKey, requestDigest, planId, created);
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
    const materialized = await this.materialize(workspace, input.idempotencyKey, revision, false);
    await this.bindAssigned(workspace.id, revision.id);
    await this.store.pointWorkspace(workspace.id, materialized.snapshot.id);
    await this.store.attachAuditEntitlement(actor.subject, input.idempotencyKey, materialized.snapshot.id);
    return (await this.storedView(actor.subject, input.idempotencyKey, requestDigest)) ?? materialized.view;
  }

  async grant(actor: ProductActor, input: GrantContentCollection): Promise<ProductEntitlementView> {
    // LCA13：内容赠送独立持能（entitlement.gift），与订阅调整（subscription.manage）分离。
    denyUnless(actor, "entitlement.gift");
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

  /**
   * LCA08：订阅生命周期事件（provider 事件、运营意图、时间边界 sweep）
   * 驱动的权益快照重算。digest 未变则不动快照；变化时复用 materialize 的
   * digest 去重 / 旧快照回指 / 并发重试语义。同时返回 AI 周期额度指令，
   * 由调用方落到目标 workspace 账本（本方法不写 workspace database）。
   */
  async refreshSubscriptionDriven(
    workspaceId: string,
    ctx: { correlationId: string; reason?: string },
  ): Promise<{ changed: boolean; planCycle: PlanCycleDirective | null }> {
    const workspace = await this.store.workspaceById(workspaceId);
    if (!workspace) throw new ProductEntitlementError("not_found", "工作区不存在");
    const { draft, subscription } = await this.resolveFor(workspace);
    // 周期身份来自订阅事实（订阅级付费窗口），与 item 生效时间解耦；
    // 事件身份（item id + item 生效时间）来自当前已确认商业事件，是升级
    // 补发的事件键与折算时点，重试不使用 now。
    const planCycle = planCycleDirective(
      workspace.dbName,
      draft,
      subscription ? { cycleFrom: subscription.cycleFrom, cycleUntil: subscription.cycleUntil } : null,
      subscription ? { key: subscription.itemId, effectiveAt: subscription.effectiveFrom } : null,
    );
    const current = await this.store.currentSnapshot(workspace.id);
    if (current && current.digest === draft.digest) {
      return { changed: false, planCycle };
    }
    await this.materialize(workspace, `lifecycle:${ctx.correlationId}`);
    return { changed: true, planCycle };
  }

  async getForOperator(actor: ProductActor, workspaceSlug: string): Promise<ProductEntitlementView> {
    denyUnless(actor, "quota.read");
    const workspace = await this.requireWorkspace(workspaceSlug);
    const view = await this.viewFor(workspace);
    return await this.enrichOperatorView(workspace, view);
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
    action: "assign" | "grant" | "revoke" | "repair",
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
    point = true,
  ): Promise<{ view: ProductEntitlementView; snapshot: SnapshotRecord }> {
    const draft = await this.draftFor(workspace, revisionOverride);
    const resource = await this.store.resourceStatus(workspace.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const same = await this.store.snapshotByDigest(workspace.id, draft.digest);
      if (same) {
        if (point) await this.store.pointWorkspace(workspace.id, same.id);
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
        if (point) await this.store.pointWorkspace(workspace.id, saved.id);
        return { snapshot: saved, view: toView(workspace.slug, saved.revision, saved, resource) };
      }
    }
    throw new ProductEntitlementError("conflict", "权益解析发生并发冲突");
  }

  private async draftFor(workspace: WorkspaceRef, revisionOverride?: ProductRevisionBody): Promise<EntitlementDraft> {
    return (await this.resolveFor(workspace, revisionOverride)).draft;
  }

  private async resolveFor(workspace: WorkspaceRef, revisionOverride?: ProductRevisionBody): Promise<{
    draft: EntitlementDraft;
    subscription: SubscriptionFact | null;
  }> {
    const subscription = await this.store.activeItem(workspace.id);
    const subscriptionForResolve = subscription && revisionOverride
      ? { ...subscription, productPlanRevisionId: revisionOverride.id }
      : subscription;
    const productRevision = revisionOverride
      ?? (subscription?.productPlanRevisionId ? await this.store.productRevision(subscription.productPlanRevisionId) : null);
    return {
      draft: resolveEntitlement({
        now: this.now().toISOString(),
        subscription: subscriptionForResolve,
        productRevision,
        grants: await this.store.grants(workspace.id),
      }),
      subscription,
    };
  }

  /**
   * LCA13：撤销临时内容赠送。只移除该赠送来源（content_grant 行不可变，
   * 撤销是追加记录）；基础订阅来源与其余授权保持不变。幂等：同键重放返回
   * 同一结果；同一赠送被其他键撤销过也按成功收敛。
   */
  async revokeGrant(actor: ProductActor, input: RevokeContentGrant): Promise<{ before: ProductEntitlementView; after: ProductEntitlementView }> {
    denyUnless(actor, "entitlement.gift");
    const requestDigest = digestOf(input);
    const workspace = await this.requireWorkspace(input.workspaceSlug);
    const grant = await this.store.grantById(workspace.id, input.grantId);
    if (!grant) throw new ProductEntitlementError("not_found", "赠送授权不存在或不属于该工作区");
    const before = await this.viewFor(workspace);
    const replay = await this.claim(actor, "revoke", input.reason, input.idempotencyKey, requestDigest, workspace.id, null);
    if (!replay) {
      const wrote = await this.store.insertGrantRevocation(workspace.id, input.grantId, input.reason, actor.subject, input.idempotencyKey);
      if (wrote === "conflict") throw new ProductEntitlementError("conflict", "撤销请求与既有撤销冲突");
      await this.materialize(workspace, `revoke:${input.idempotencyKey}`);
      await this.store.attachAuditEntitlement(actor.subject, input.idempotencyKey, (await this.store.currentSnapshot(workspace.id))?.id ?? "");
    }
    const after = (await this.storedView(actor.subject, input.idempotencyKey, requestDigest))
      ?? await this.viewFor(workspace);
    return { before, after };
  }

  /** LCA13：交付修复影响预览（只读，不下单、不写快照）。 */
  async describeDeliveryRepair(actor: ProductActor, workspaceSlug: string): Promise<{ current: ProductEntitlementView; target: ProductEntitlementView; boundRevisionId: string | null }> {
    denyUnless(actor, "entitlement.repair");
    const workspace = await this.requireWorkspace(workspaceSlug);
    const subscription = await this.store.activeItem(workspace.id);
    const boundRevision = subscription?.productPlanRevisionId
      ? await this.store.productRevision(subscription.productPlanRevisionId) : null;
    if (subscription?.productPlanRevisionId && !boundRevision) {
      throw new ProductEntitlementError("invalid_request", "订阅绑定的产品版本不存在");
    }
    const current = await this.viewFor(workspace);
    const target = boundRevision
      ? (await this.materializePreview(workspace, boundRevision))
      : current;
    return { current, target, boundRevisionId: boundRevision?.id ?? null };
  }

  /**
   * LCA13：对投影失败的工作区做限定修订的幂等交付重试。重试目标始终是
   * 当前绑定的产品修订（重算当时事实），配合 expectedCurrentRevision 护栏：
   * 快照已前进即冲突，绝不盲目覆盖新撤权；pointWorkspace 的绑定产品保护
   * 保证旧修订快照不能移动指针。失败不重复下单（本子系统无订单写入）、
   * 不重复发额度（plan-cycle 同步按 period_key/事件键幂等）。
   */
  async repairDelivery(actor: ProductActor, input: RepairContentDelivery): Promise<DeliveryRepairResult> {
    denyUnless(actor, "entitlement.repair");
    const requestDigest = digestOf(input);
    const workspace = await this.requireWorkspace(input.workspaceSlug);
    const subscription = await this.store.activeItem(workspace.id);
    if (!subscription || subscription.status !== "active") {
      throw new ProductEntitlementError("no_subscription", "工作区没有可修复的有效订阅");
    }
    const boundRevision = subscription.productPlanRevisionId
      ? await this.store.productRevision(subscription.productPlanRevisionId) : null;
    if (subscription.productPlanRevisionId && !boundRevision) {
      throw new ProductEntitlementError("invalid_request", "订阅绑定的产品版本不存在");
    }
    const current = await this.viewFor(workspace);
    const currentSnapshotRecord = await this.store.currentSnapshot(workspace.id);
    // 限定修订护栏只拦「快照仍在但已被别人推进」的盲目重试；指针丢失/损坏
    // （currentSnapshotRecord 缺失）正是要修复的投影故障本身，不拦。
    if (currentSnapshotRecord && input.expectedCurrentRevision !== null && input.expectedCurrentRevision !== current.revision) {
      throw new ProductEntitlementError("conflict", "限定修订与当前快照不一致，请刷新预览后重试");
    }
    const before = current;
    const replay = await this.claim(actor, "repair", input.reason, input.idempotencyKey, requestDigest, workspace.id, boundRevision?.id ?? null);
    let after = before;
    let changed = false;
    if (!replay) {
      const beforeSnapshot = await this.store.currentSnapshot(workspace.id);
      const materialized = await this.materialize(workspace, `repair:${input.idempotencyKey}`, boundRevision ?? undefined);
      after = materialized.view;
      changed = materialized.snapshot.id !== beforeSnapshot?.id;
      await this.store.attachAuditEntitlement(actor.subject, input.idempotencyKey, materialized.snapshot.id);
    } else {
      after = replay;
      changed = replay.revision !== before.revision;
    }
    let planCycleSynced = false;
    if (this.ops?.syncPlanCycle) {
      const runtime = await this.store.workspaceById(workspace.id);
      const { draft, subscription } = await this.resolveFor(workspace, boundRevision ?? undefined);
      if (runtime && draft.baseSourceKind !== "none") {
        const planCycle = planCycleDirective(
          runtime.dbName,
          draft,
          subscription ? { cycleFrom: subscription.cycleFrom, cycleUntil: subscription.cycleUntil } : null,
          subscription ? { key: subscription.itemId, effectiveAt: subscription.effectiveFrom } : null,
        );
        if (planCycle) {
          await this.ops.syncPlanCycle(planCycle, `repair:${input.idempotencyKey}`);
          planCycleSynced = true;
        }
      }
    }
    return {
      before,
      after: await this.enrichOperatorView(workspace, after),
      changed,
      planCycleSynced,
      note: changed ? "权益快照已重算并重新指向绑定修订" : "快照未变化（digest 一致或幂等重放）",
    };
  }

  /**
   * LCA13：异常队列。只列已确认商业来源（活跃订阅项）的工作区：
   - delivery_pending = 快照落后于绑定修订（尚未交付）；
   - projection_failure = 快照就绪但内容投影核验不通过；
   - ai_settlement_anomaly = AI 账本出现卡死预留等结算异常。
   - 正常到期（订阅过期/结束）与合法 over_limit 不入队。
   */
  async exceptions(actor: ProductActor, options: { limit?: number; offset?: number } = {}): Promise<{ items: EntitlementExceptionItem[]; total: number | null }> {
    denyUnless(actor, "quota.read");
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const candidates = await this.store.deliveryCandidates(limit, offset);
    const items: EntitlementExceptionItem[] = [];
    for (const workspace of candidates) {
      const [subscription, current, ai] = await Promise.all([
        this.store.activeItem(workspace.id),
        this.store.currentSnapshot(workspace.id),
        this.ops?.aiStatus ? this.ops.aiStatus(workspace.dbName) : Promise.resolve(null),
      ]);
      const kinds: EntitlementExceptionItem["kinds"] = [];
      const detail: EntitlementExceptionItem["detail"] = {
        boundRevisionId: subscription?.productPlanRevisionId ?? null,
        currentRevisionId: current?.id ?? null,
        currentRevision: current?.revision ?? null,
        projectionVerdict: null,
        stuckReservations: 0,
        anomalyNote: null,
      };
      if (subscription?.productPlanRevisionId && (!current || current.productPlanRevisionId !== subscription.productPlanRevisionId)) {
        kinds.push("delivery_pending");
      }
      if (current && current.collections.length > 0 && this.ops?.projectionVerify) {
        const verification = await this.ops.projectionVerify(current.collections);
        if (verification && (verification.verdict === "empty_collection" || verification.verdict === "projection_error")) {
          kinds.push("projection_failure");
          detail.projectionVerdict = verification.verdict;
        }
      }
      if (ai?.settlementAnomaly) {
        kinds.push("ai_settlement_anomaly");
        detail.stuckReservations = ai.stuckReservations ?? 0;
        detail.anomalyNote = ai.anomalyNote;
      }
      if (kinds.length > 0) items.push({ workspaceSlug: workspace.slug, kinds, detail });
    }
    return { items, total: null };
  }

  /** LCA13：运营解释视图增强——来源理由/操作者、投影核验、AI 账本事实。 */
  private async enrichOperatorView(workspace: WorkspaceRef, view: ProductEntitlementView): Promise<ProductEntitlementView> {
    const runtime = await this.store.workspaceById(workspace.id);
    const [facts, projection, ai] = await Promise.all([
      this.store.grantFacts(workspace.id),
      view.content.collections.length > 0 && this.ops?.projectionVerify
        ? this.ops.projectionVerify(view.content.collections)
        : Promise.resolve(null),
      runtime && this.ops?.aiStatus ? this.ops.aiStatus(runtime.dbName) : Promise.resolve(null),
    ]);
    const factById = new Map(facts.map((fact) => [fact.id, fact]));
    const sources = view.content.sources.map((source) => {
      const fact = factById.get(source.sourceId);
      return fact ? { ...source, reason: fact.reason, operatorSubject: fact.operatorSubject, revoked: fact.revoked } : source;
    });
    return {
      ...view,
      content: { ...view.content, sources, projection: projection ?? null },
      ai: ai ? {
        ...view.ai,
        consumableAllowance: ai.consumableAllowance,
        ledger: ai.consumableAllowance === null ? view.ai.ledger : "ok",
        ledgerLabel: ai.consumableAllowance === null ? view.ai.ledgerLabel : "账本可用",
        reserved: ai.reserved,
        settled: ai.settled,
        suspended: ai.suspended,
        terminated: ai.terminated,
        expired: ai.expired,
        stuckReservations: ai.stuckReservations,
      } : view.ai,
    };
  }

  /** 只读预览：按目标修订计算草稿视图，不写快照、不移动指针。 */
  private async materializePreview(workspace: WorkspaceRef, revision: ProductRevisionBody): Promise<ProductEntitlementView> {
    const { draft } = await this.resolveFor(workspace, revision);
    const resource = await this.store.resourceStatus(workspace.id);
    const current = await this.store.currentSnapshot(workspace.id);
    return toView(workspace.slug, current?.revision ?? 0, draft, resource);
  }
}
