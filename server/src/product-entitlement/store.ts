import { DateTime, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString, toStringRecordId, toSurrealNone } from "../db/surreal-values";
import { env } from "../env";
import type { ContentGrantFact, FeatureValue, NamedCollection, ProductRevisionBody, ResourceFact, SubscriptionFact } from "./resolve";
import type { AuditRecord, ProductEntitlementStore, SnapshotRecord, WorkspaceRef } from "./service";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type SessionFactory = (database: string, namespace: string) => Promise<Queryable>;
type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];
const first = (value: unknown): Row | null => rows(value)[0] ?? null;
const idOf = (value: unknown): string | null => toStringRecordId(value)?.toString() ?? (typeof value === "string" ? value : null);
const when = (value: unknown): string | null => toIsoDateTimeString(value);
const asNumber = (value: unknown): number | null => typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
const recordParam = (value: unknown): StringRecordId => {
  const id = idOf(value);
  if (!id) throw new Error("missing record id");
  return new StringRecordId(id);
};

function collectionsOf(value: unknown): NamedCollection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Row;
    const key = typeof row.collection_key === "string" ? row.collection_key : null;
    const label = typeof row.display_name === "string" ? row.display_name : null;
    return key && label ? [{ key, label }] : [];
  });
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function featuresOf(value: unknown): FeatureValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Row;
    if (typeof row.feature_key !== "string" || typeof row.enabled !== "boolean") return [];
    return [{ key: row.feature_key, enabled: row.enabled, limit: asNumber(row.limit_value) }];
  });
}

function isConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already|duplicate|unique/iu.test(message);
}

export class SurrealProductEntitlementStore implements ProductEntitlementStore {
  constructor(private readonly getSession: SessionFactory = getRootDatabaseSession, private readonly namespace = env.SURREAL_NS) {}

  private async db(): Promise<Queryable> {
    return await this.getSession("_system", this.namespace);
  }

  async workspaceBySlug(slug: string): Promise<WorkspaceRef | null> {
    const row = first(await (await this.db()).query(`SELECT id, slug FROM workspace WHERE slug = $slug LIMIT 1;`, { slug }));
    const id = idOf(row?.id);
    return row && id && typeof row.slug === "string" ? { id, slug: row.slug } : null;
  }

  async membership(subject: string, workspaceId: string): Promise<"admin" | "participant" | null> {
    const row = first(await (await this.db()).query(`SELECT role FROM user_workspace_index
      WHERE subject = $subject AND workspace = $workspace AND disabled_at = NONE LIMIT 1;`, {
      subject, workspace: new StringRecordId(workspaceId),
    }));
    return row?.role === "admin" || row?.role === "participant" ? row.role : null;
  }

  async activeItem(workspaceId: string): Promise<SubscriptionFact | null> {
    const db = await this.db();
    const item = first(await db.query(`SELECT * FROM quota_subscription_item WHERE active_workspace = $workspace LIMIT 1;`, {
      workspace: new StringRecordId(workspaceId),
    }));
    if (!item) return null;
    const itemId = idOf(item.id);
    const subscriptionId = idOf(item.subscription);
    const effectiveFrom = when(item.effective_from);
    if (!itemId || !subscriptionId || !effectiveFrom || typeof item.status !== "string") return null;
    const subscription = first(await db.query(`SELECT * FROM $id;`, { id: new StringRecordId(subscriptionId) }));
    const accountId = idOf(subscription?.billing_account);
    const account = accountId ? first(await db.query(`SELECT account_key FROM $id;`, { id: new StringRecordId(accountId) })) : null;
    if (!subscription || typeof account?.account_key !== "string" || typeof subscription.status !== "string") return null;
    return {
      itemId,
      status: item.status as SubscriptionFact["status"],
      effectiveFrom,
      effectiveUntil: when(item.effective_until),
      productPlanRevisionId: idOf(item.product_plan_revision),
      subscriptionId,
      billingAccountKey: account.account_key,
      subscriptionStatus: subscription.status as SubscriptionFact["subscriptionStatus"],
    };
  }

  async bindProductRevision(itemId: string, productPlanRevisionId: string): Promise<void> {
    await (await this.db()).query(`UPDATE $item SET product_plan_revision = $revision, revision += 1;`, {
      item: new StringRecordId(itemId), revision: new StringRecordId(productPlanRevisionId),
    });
  }

  async productRevision(id: string): Promise<ProductRevisionBody | null> {
    const db = await this.db();
    const row = first(await db.query(`SELECT * FROM $id;`, { id: new StringRecordId(id) }));
    if (!row) return null;
    const plan = first(await db.query(`SELECT plan_key, display_name FROM $id;`, { id: recordParam(row.plan) }));
    const content = first(await db.query(`SELECT collections, actions FROM $id;`, { id: recordParam(row.content_template) }));
    const ai = first(await db.query(`SELECT actions FROM $id;`, { id: recordParam(row.ai_template) }));
    const features = first(await db.query(`SELECT features FROM $id;`, { id: recordParam(row.feature_template) }));
    const revision = asNumber(row.revision);
    if (!plan || typeof plan.plan_key !== "string" || typeof plan.display_name !== "string" || revision === null) return null;
    return {
      id, planKey: plan.plan_key, planName: plan.display_name, revision,
      collections: collectionsOf(content?.collections), actions: stringsOf(content?.actions),
      aiActions: stringsOf(ai?.actions), features: featuresOf(features?.features),
    };
  }

  async resourceTemplateExists(id: string): Promise<boolean> {
    const row = first(await (await this.db()).query(`SELECT id FROM $id;`, { id: new StringRecordId(id) }));
    return Boolean(row);
  }

  async upsertCollection(key: string, label: string): Promise<{ id: string; key: string; label: string }> {
    const row = first(await (await this.db()).query(`INSERT INTO content_collection {
      collection_key: $key, display_name: $label, status: "active"
    } ON DUPLICATE KEY UPDATE display_name = $label RETURN AFTER;`, { key, label }));
    const id = idOf(row?.id);
    if (!id) throw new Error("content collection was not saved");
    return { id, key, label };
  }

  async insertContentTemplate(actor: string, collections: { id: string; key: string; label: string }[], actions: string[]): Promise<string> {
    const row = first(await (await this.db()).query(`CREATE content_template_revision CONTENT {
      collections: $collections, actions: $actions, created_by_subject: $actor
    };`, {
      actor, actions,
      collections: collections.map((item) => ({
        collection: new StringRecordId(item.id), collection_key: item.key, display_name: item.label,
      })),
    }));
    const id = idOf(row?.id);
    if (!id) throw new Error("content template was not saved");
    return id;
  }

  async insertAiTemplate(actor: string, actions: string[]): Promise<string> {
    const row = first(await (await this.db()).query(`CREATE ai_template_revision CONTENT {
      actions: $actions, created_by_subject: $actor
    };`, { actor, actions }));
    const id = idOf(row?.id);
    if (!id) throw new Error("ai template was not saved");
    return id;
  }

  async insertFeatureTemplate(actor: string, features: FeatureValue[]): Promise<string> {
    const row = first(await (await this.db()).query(`CREATE feature_template_revision CONTENT {
      features: $features, created_by_subject: $actor
    };`, {
      actor,
      features: features.map((feature) => ({ feature_key: feature.key, enabled: feature.enabled, limit_value: toSurrealNone(feature.limit) })),
    }));
    const id = idOf(row?.id);
    if (!id) throw new Error("feature template was not saved");
    return id;
  }

  async upsertPlan(planKey: string, displayName: string): Promise<string> {
    const row = first(await (await this.db()).query(`INSERT INTO product_plan {
      plan_key: $planKey, display_name: $displayName, status: "active"
    } ON DUPLICATE KEY UPDATE display_name = $displayName RETURN AFTER;`, { planKey, displayName }));
    const id = idOf(row?.id);
    if (!id) throw new Error("product plan was not saved");
    return id;
  }

  async insertProductRevision(input: {
    planId: string; revision: number; resourceTemplateId: string; contentTemplateId: string;
    aiTemplateId: string; featureTemplateId: string; actor: string; correlationId: string;
  }): Promise<string | null> {
    try {
      const row = first(await (await this.db()).query(`INSERT INTO product_plan_revision {
        plan: $plan, revision: $revision, resource_template: $resource, content_template: $content,
        ai_template: $ai, feature_template: $feature, created_by_subject: $actor, correlation_id: $correlationId
      };`, {
        plan: new StringRecordId(input.planId), revision: input.revision,
        resource: new StringRecordId(input.resourceTemplateId), content: new StringRecordId(input.contentTemplateId),
        ai: new StringRecordId(input.aiTemplateId), feature: new StringRecordId(input.featureTemplateId),
        actor: input.actor, correlationId: input.correlationId,
      }));
      return idOf(row?.id);
    } catch (error) {
      if (isConflict(error)) return null;
      throw error;
    }
  }

  async productRevisionId(planId: string, revision: number): Promise<string | null> {
    const row = first(await (await this.db()).query(`SELECT id FROM product_plan_revision WHERE plan = $plan AND revision = $revision LIMIT 1;`, {
      plan: new StringRecordId(planId), revision,
    }));
    return idOf(row?.id);
  }

  async setActiveRevision(planId: string, revisionId: string): Promise<void> {
    await (await this.db()).query(`
      LET $head = (SELECT active_revision FROM ONLY $plan);
      LET $linked = IF $head = NONE THEN NONE ELSE $head.active_revision END;
      LET $next = (SELECT revision FROM ONLY $revision);
      IF $next.revision != NONE AND ($linked = NONE OR $linked.revision < $next.revision) {
        UPDATE $plan SET active_revision = $revision;
      };
    `, {
      plan: new StringRecordId(planId), revision: new StringRecordId(revisionId),
    });
  }

  async grants(workspaceId: string): Promise<ContentGrantFact[]> {
    return rows(await (await this.db()).query(`SELECT * FROM content_grant WHERE workspace = $workspace ORDER BY id;`, {
      workspace: new StringRecordId(workspaceId),
    })).flatMap((row) => {
      const id = idOf(row.id);
      const effectiveFrom = when(row.effective_from);
      if (!id || !effectiveFrom || typeof row.label !== "string") return [];
      return [{
        id, label: row.label, collections: collectionsOf(row.collections), actions: stringsOf(row.actions),
        effectiveFrom, effectiveUntil: when(row.effective_until),
      }];
    });
  }

  async insertGrant(workspaceId: string, grant: Omit<ContentGrantFact, "id" | "collections"> & {
    collections: { id: string; key: string; label: string }[];
    reason: string;
    actor: string;
    idempotencyKey: string;
  }): Promise<string | null> {
    try {
      const row = first(await (await this.db()).query(`INSERT INTO content_grant {
        workspace: $workspace, label: $label, collections: $collections, actions: $actions,
        effective_from: $effectiveFrom, effective_until: $effectiveUntil, reason: $reason,
        created_by_subject: $actor, idempotency_key: $idempotencyKey
      };`, {
        workspace: new StringRecordId(workspaceId), label: grant.label, actions: grant.actions,
        collections: grant.collections.map((item) => ({
          collection_key: item.key,
          display_name: item.label,
          collection: new StringRecordId(item.id),
        })),
        effectiveFrom: new DateTime(grant.effectiveFrom),
        effectiveUntil: toSurrealNone(grant.effectiveUntil ? new DateTime(grant.effectiveUntil) : null),
        reason: grant.reason, actor: grant.actor, idempotencyKey: grant.idempotencyKey,
      }));
      return idOf(row?.id);
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = first(await (await this.db()).query(`SELECT id FROM content_grant WHERE workspace = $workspace AND idempotency_key = $key LIMIT 1;`, {
        workspace: new StringRecordId(workspaceId), key: grant.idempotencyKey,
      }));
      return idOf(existing?.id);
    }
  }

  async currentSnapshot(workspaceId: string): Promise<SnapshotRecord | null> {
    const pointer = first(await (await this.db()).query(`SELECT current_product_entitlement FROM $workspace;`, {
      workspace: new StringRecordId(workspaceId),
    }));
    const id = idOf(pointer?.current_product_entitlement);
    return id ? await this.snapshotById(id) : null;
  }

  async snapshotById(id: string): Promise<SnapshotRecord | null> {
    return await this.mapSnapshot(first(await (await this.db()).query(`SELECT * FROM $id;`, { id: new StringRecordId(id) })));
  }

  async newestSnapshotRevision(workspaceId: string, productPlanRevisionId: string): Promise<number | null> {
    const row = first(await (await this.db()).query(`SELECT revision FROM workspace_product_entitlement
      WHERE workspace = $workspace AND product_plan_revision = $product
      ORDER BY revision DESC LIMIT 1;`, {
      workspace: new StringRecordId(workspaceId),
      product: new StringRecordId(productPlanRevisionId),
    }));
    return asNumber(row?.revision);
  }

  async snapshotByDigest(workspaceId: string, digest: string): Promise<SnapshotRecord | null> {
    return await this.mapSnapshot(first(await (await this.db()).query(`SELECT * FROM workspace_product_entitlement
      WHERE workspace = $workspace AND digest = $digest LIMIT 1;`, {
      workspace: new StringRecordId(workspaceId), digest,
    })));
  }

  async insertSnapshot(row: SnapshotRecord): Promise<"ok" | "conflict"> {
    try {
      await (await this.db()).query(`INSERT INTO workspace_product_entitlement {
        workspace: $workspace, revision: $revision, digest: $digest, summary: $summary, resolver_version: $resolverVersion,
        base_source_kind: $baseSourceKind, base_source_id: $baseSourceId, product_plan_revision: $productPlanRevision,
        product_plan_key: $productPlanKey, product_plan_name: $productPlanName, product_revision_number: $productRevisionNumber,
        effective_from: $effectiveFrom, effective_until: $effectiveUntil, content_collections: $collections,
        content_actions: $actions, content_sources: $sources, ai_actions: $aiActions, features: $features,
        correlation_id: $correlationId
      };`, {
        workspace: new StringRecordId(row.workspaceId), revision: row.revision, digest: row.digest, summary: row.summary,
        resolverVersion: row.resolverVersion, baseSourceKind: row.baseSourceKind, baseSourceId: toSurrealNone(row.baseSourceId),
        productPlanRevision: toSurrealNone(row.productPlanRevisionId ? new StringRecordId(row.productPlanRevisionId) : null),
        productPlanKey: toSurrealNone(row.productPlanKey), productPlanName: toSurrealNone(row.productPlanName),
        productRevisionNumber: toSurrealNone(row.productRevisionNumber),
        effectiveFrom: toSurrealNone(row.effectiveFrom ? new DateTime(row.effectiveFrom) : null),
        effectiveUntil: toSurrealNone(row.effectiveUntil ? new DateTime(row.effectiveUntil) : null),
        collections: row.collections.map((item) => ({ collection_key: item.key, display_name: item.label })),
        actions: row.actions,
        sources: row.sources.map((source) => ({
          kind: source.kind, source_id: source.sourceId, label: source.label,
          effective_from: new DateTime(source.effectiveFrom),
          effective_until: toSurrealNone(source.effectiveUntil ? new DateTime(source.effectiveUntil) : null),
        })),
        aiActions: row.aiActions,
        features: row.features.map((feature) => ({ feature_key: feature.key, enabled: feature.enabled, limit_value: toSurrealNone(feature.limit) })),
        correlationId: row.correlationId,
      });
      return "ok";
    } catch (error) {
      if (isConflict(error)) return "conflict";
      throw error;
    }
  }

  async pointWorkspace(workspaceId: string, snapshotId: string): Promise<void> {
    await (await this.db()).query(`
      LET $next = (SELECT revision FROM ONLY $snapshot);
      LET $current = (SELECT current_product_entitlement FROM ONLY $workspace);
      LET $linked = IF $current = NONE THEN NONE ELSE $current.current_product_entitlement END;
      IF $next.revision != NONE AND ($linked = NONE OR $linked.revision < $next.revision) {
        UPDATE $workspace SET current_product_entitlement = $snapshot;
      };
    `, {
      workspace: new StringRecordId(workspaceId), snapshot: new StringRecordId(snapshotId),
    });
  }

  async auditByKey(actor: string, idempotencyKey: string): Promise<AuditRecord | null> {
    const row = first(await (await this.db()).query(`SELECT * FROM product_entitlement_audit
      WHERE actor_subject = $actor AND idempotency_key = $idempotencyKey LIMIT 1;`, { actor, idempotencyKey }));
    if (!row || typeof row.action !== "string" || typeof row.request_digest !== "string") return null;
    return {
      action: row.action as AuditRecord["action"], requestDigest: row.request_digest,
      entitlementId: idOf(row.entitlement), productPlanRevisionId: idOf(row.product_plan_revision),
    };
  }

  async insertAudit(row: AuditRecord & { actor: string; idempotencyKey: string; reason: string; workspaceId: string | null }): Promise<"ok" | "conflict"> {
    try {
      await (await this.db()).query(`INSERT INTO product_entitlement_audit {
        actor_subject: $actor, action: $action, workspace: $workspace, reason: $reason, idempotency_key: $idempotencyKey,
        request_digest: $requestDigest, entitlement: $entitlement, product_plan_revision: $productPlanRevision
      };`, {
        actor: row.actor, action: row.action, reason: row.reason, idempotencyKey: row.idempotencyKey, requestDigest: row.requestDigest,
        workspace: row.workspaceId ? new StringRecordId(row.workspaceId) : undefined,
        entitlement: row.entitlementId ? new StringRecordId(row.entitlementId) : undefined,
        productPlanRevision: row.productPlanRevisionId ? new StringRecordId(row.productPlanRevisionId) : undefined,
      });
      return "ok";
    } catch (error) {
      if (isConflict(error)) return "conflict";
      throw error;
    }
  }

  async attachAuditEntitlement(actor: string, idempotencyKey: string, entitlementId: string): Promise<"ok" | "conflict"> {
    const updated = first(await (await this.db()).query(`UPDATE product_entitlement_audit SET entitlement = $entitlement
      WHERE actor_subject = $actor AND idempotency_key = $key AND entitlement = NONE RETURN AFTER;`, {
      actor, key: idempotencyKey, entitlement: new StringRecordId(entitlementId),
    }));
    if (updated) return "ok";
    const current = await this.auditByKey(actor, idempotencyKey);
    return current?.entitlementId === entitlementId ? "ok" : "conflict";
  }

  async resourceStatus(workspaceId: string): Promise<ResourceFact> {
    const db = await this.db();
    const workspace = first(await db.query(`SELECT applied_entitlement, desired_entitlement FROM $workspace;`, {
      workspace: new StringRecordId(workspaceId),
    }));
    const applied = await this.planOf(db, idOf(workspace?.applied_entitlement));
    const desired = await this.planOf(db, idOf(workspace?.desired_entitlement));
    const runtime = first(await db.query(`SELECT sync_state FROM workspace_quota_runtime WHERE workspace = $workspace LIMIT 1;`, {
      workspace: new StringRecordId(workspaceId),
    }));
    return {
      appliedPlanKey: applied?.key ?? null, appliedPlanName: applied?.name ?? null, appliedRevision: applied?.revision ?? null,
      desiredPlanKey: desired?.key ?? null, syncState: typeof runtime?.sync_state === "string" ? runtime.sync_state : null,
    };
  }

  private async planOf(db: Queryable, entitlementId: string | null): Promise<{ key: string; name: string; revision: number } | null> {
    if (!entitlementId) return null;
    const entitlement = first(await db.query(`SELECT plan_revision FROM $id;`, { id: new StringRecordId(entitlementId) }));
    const planRevisionId = idOf(entitlement?.plan_revision);
    if (!planRevisionId) return null;
    const planRevision = first(await db.query(`SELECT plan, revision FROM $id;`, { id: new StringRecordId(planRevisionId) }));
    const planId = idOf(planRevision?.plan);
    const revision = asNumber(planRevision?.revision);
    if (!planId || revision === null) return null;
    const plan = first(await db.query(`SELECT plan_key, display_name FROM $id;`, { id: new StringRecordId(planId) }));
    if (typeof plan?.plan_key !== "string" || typeof plan.display_name !== "string") return null;
    return { key: plan.plan_key, name: plan.display_name, revision };
  }

  private async mapSnapshot(row: Row | null): Promise<SnapshotRecord | null> {
    if (!row) return null;
    const id = idOf(row.id);
    const workspaceId = idOf(row.workspace);
    const revision = asNumber(row.revision);
    if (!id || !workspaceId || revision === null || typeof row.digest !== "string" || typeof row.summary !== "string") return null;
    const sources = Array.isArray(row.content_sources) ? row.content_sources.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as Row;
      const kind: "base" | "grant" | null = source.kind === "base" || source.kind === "grant" ? source.kind : null;
      const effectiveFrom = when(source.effective_from);
      if (!kind || typeof source.source_id !== "string" || typeof source.label !== "string" || !effectiveFrom) return [];
      return [{ kind, sourceId: source.source_id, label: source.label, effectiveFrom, effectiveUntil: when(source.effective_until) }];
    }) : [];
    const workspace = first(await (await this.db()).query(`SELECT slug FROM $workspace;`, { workspace: new StringRecordId(workspaceId) }));
    return {
      id, workspaceId, workspaceSlug: typeof workspace?.slug === "string" ? workspace.slug : "", revision, digest: row.digest, summary: row.summary,
      resolverVersion: typeof row.resolver_version === "string" ? row.resolver_version : "",
      baseSourceKind: row.base_source_kind === "subscription" || row.base_source_kind === "trial" ? row.base_source_kind : "none",
      baseSourceId: typeof row.base_source_id === "string" ? row.base_source_id : null,
      productPlanRevisionId: idOf(row.product_plan_revision),
      productPlanKey: typeof row.product_plan_key === "string" ? row.product_plan_key : null,
      productPlanName: typeof row.product_plan_name === "string" ? row.product_plan_name : null,
      productRevisionNumber: asNumber(row.product_revision_number),
      effectiveFrom: when(row.effective_from), effectiveUntil: when(row.effective_until),
      collections: collectionsOf(row.content_collections), actions: stringsOf(row.content_actions), sources,
      aiActions: stringsOf(row.ai_actions), features: featuresOf(row.features),
      correlationId: typeof row.correlation_id === "string" ? row.correlation_id : "",
    };
  }
}
