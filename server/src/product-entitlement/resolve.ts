import { PRODUCT_ENTITLEMENT_RESOLVER_VERSION, type ProductEntitlementView } from "@surreal-ck/shared";
import { canonicalSha256 } from "../quota/canonical";

export type NamedCollection = { key: string; label: string };
export type FeatureValue = { key: string; enabled: boolean; limit: number | null };
export type ContentSource = ProductEntitlementView["content"]["sources"][number];

export type ProductRevisionBody = {
  id: string;
  planKey: string;
  planName: string;
  revision: number;
  collections: NamedCollection[];
  actions: string[];
  aiActions: string[];
  features: FeatureValue[];
};

export type SubscriptionFact = {
  itemId: string;
  status: "scheduled" | "active" | "ended";
  effectiveFrom: string;
  effectiveUntil: string | null;
  productPlanRevisionId: string | null;
  subscriptionId: string;
  billingAccountKey: string;
  subscriptionStatus: "pending" | "trialing" | "active" | "past_due" | "paused" | "canceled" | "expired";
};

export type ContentGrantFact = {
  id: string;
  label: string;
  collections: NamedCollection[];
  actions: string[];
  effectiveFrom: string;
  effectiveUntil: string | null;
};

export type ResourceFact = {
  appliedPlanKey: string | null;
  appliedPlanName: string | null;
  appliedRevision: number | null;
  desiredPlanKey: string | null;
  syncState: string | null;
};

export type ResolveFacts = {
  now: string;
  subscription: SubscriptionFact | null;
  productRevision: ProductRevisionBody | null;
  grants: readonly ContentGrantFact[];
};

export type EntitlementDraft = {
  digest: string;
  summary: string;
  resolverVersion: string;
  baseSourceKind: "subscription" | "trial" | "none";
  baseSourceId: string | null;
  productPlanRevisionId: string | null;
  productPlanKey: string | null;
  productPlanName: string | null;
  productRevisionNumber: number | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  collections: NamedCollection[];
  actions: string[];
  sources: ContentSource[];
  aiActions: string[];
  features: FeatureValue[];
  correlationId: string;
};

function activeWindow(now: string, from: string, until: string | null): boolean {
  return from <= now && (until === null || until > now);
}

function usableBase(now: string, subscription: SubscriptionFact | null): SubscriptionFact | null {
  if (!subscription) return null;
  if (subscription.status !== "active") return null;
  if (!activeWindow(now, subscription.effectiveFrom, subscription.effectiveUntil)) return null;
  if (subscription.subscriptionStatus === "active") return subscription;
  if (subscription.subscriptionStatus === "trialing") return subscription;
  return null;
}

function uniqueCollections(items: NamedCollection[]): NamedCollection[] {
  const byKey = new Map<string, NamedCollection>();
  for (const item of items) byKey.set(item.key, item);
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function resolveEntitlement(facts: ResolveFacts): EntitlementDraft {
  const subscription = usableBase(facts.now, facts.subscription);
  const linked = subscription?.productPlanRevisionId
    && facts.productRevision
    && facts.productRevision.id === subscription.productPlanRevisionId
    ? facts.productRevision
    : null;
  const kind: "subscription" | "trial" | "none" = subscription && linked
    ? (subscription.subscriptionStatus === "trialing" ? "trial" : "subscription")
    : "none";
  const grants = (kind === "none" ? [] : facts.grants.filter((grant) =>
    activeWindow(facts.now, grant.effectiveFrom, grant.effectiveUntil)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const collections = kind === "none" ? [] : uniqueCollections([
    ...(linked?.collections ?? []),
    ...grants.flatMap((grant) => grant.collections),
  ]);
  const actions = kind === "none" ? [] : [...new Set([
    ...(linked?.actions ?? []),
    ...grants.flatMap((grant) => grant.actions),
  ])].sort();
  const sources: ContentSource[] = [];
  if (linked && subscription) {
    sources.push({
      kind: "base",
      sourceId: subscription.subscriptionId,
      label: linked.planName,
      effectiveFrom: subscription.effectiveFrom,
      effectiveUntil: subscription.effectiveUntil,
    });
  }
  for (const grant of grants) {
    sources.push({
      kind: "grant",
      sourceId: grant.id,
      label: grant.label,
      effectiveFrom: grant.effectiveFrom,
      effectiveUntil: grant.effectiveUntil,
    });
  }
  sources.sort((left, right) => left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId));
  const features = (linked?.features ?? [])
    .map((feature) => ({ ...feature }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const summary = collections.length === 0
    ? "无有效内容授权"
    : `${linked?.planName ?? "产品套餐"} · ${collections.map((item) => item.label).join("、")} · 授权投影待交付`;
  const draft = {
    summary,
    resolverVersion: PRODUCT_ENTITLEMENT_RESOLVER_VERSION,
    baseSourceKind: kind,
    baseSourceId: kind === "none" ? null : subscription?.subscriptionId ?? null,
    productPlanRevisionId: linked?.id ?? null,
    productPlanKey: linked?.planKey ?? null,
    productPlanName: linked?.planName ?? null,
    productRevisionNumber: linked?.revision ?? null,
    effectiveFrom: linked && subscription ? subscription.effectiveFrom : null,
    effectiveUntil: linked && subscription ? subscription.effectiveUntil : null,
    collections,
    actions,
    sources,
    aiActions: linked ? [...linked.aiActions].sort() : [],
    features,
  };
  return { ...draft, correlationId: "", digest: canonicalSha256(draft) };
}

function resourceStatus(resource: ResourceFact): ProductEntitlementView["resource"]["status"] {
  if (!resource.appliedPlanKey && resource.desiredPlanKey) return "pending";
  if (resource.appliedPlanKey && resource.desiredPlanKey && resource.appliedPlanKey !== resource.desiredPlanKey) return "pending";
  if (resource.appliedPlanKey) return "applied";
  return "unknown";
}

const RESOURCE_LABEL = { applied: "已生效", pending: "同步中", unknown: "尚未应用" } as const;

export function toView(workspaceSlug: string, revision: number, draft: EntitlementDraft, resource: ResourceFact): ProductEntitlementView {
  const status = resourceStatus(resource);
  const hasContent = draft.collections.length > 0;
  return {
    workspaceSlug,
    revision,
    summary: draft.summary,
    resolverVersion: draft.resolverVersion,
    effectiveFrom: draft.effectiveFrom,
    effectiveUntil: draft.effectiveUntil,
    baseSource: {
      kind: draft.baseSourceKind,
      sourceId: draft.baseSourceId,
      planKey: draft.productPlanKey,
      planName: draft.productPlanName,
      planRevision: draft.productRevisionNumber,
    },
    content: {
      projectionStatus: hasContent ? "pending_delivery" : "none",
      projectionLabel: hasContent ? "待交付" : "无有效内容授权",
      consumesAiAllowance: false,
      collections: draft.collections,
      actions: draft.actions,
      sources: draft.sources,
    },
    ai: {
      actions: draft.aiActions,
      consumableAllowance: null,
      ledger: "unavailable",
      ledgerLabel: "尚无可用 AI 额度账本",
    },
    features: draft.features,
    resource: {
      appliedPlanKey: resource.appliedPlanKey,
      appliedPlanName: resource.appliedPlanName,
      appliedRevision: resource.appliedRevision,
      desiredPlanKey: resource.desiredPlanKey,
      syncState: resource.syncState,
      status,
      statusLabel: RESOURCE_LABEL[status],
    },
  };
}

