import type {
  ProductQuotaRule,
  QuotaOverridePatch,
  QuotaPlanTemplateKind,
  QuotaServiceMode,
  QuotaSubscriptionItemStatus,
  QuotaSubscriptionSource,
  QuotaSubscriptionStatus,
  ResourceEntitlementRecord,
  ResourceEntitlementSourceType,
  SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import type { DateTime, StringRecordId } from "surrealdb";
import { canonicalSha256 } from "./canonical";

export type EntitlementPlanRevision = Readonly<{
  id: StringRecordId;
  template_kind: QuotaPlanTemplateKind;
  rules: readonly ProductQuotaRule[];
}>;

export type EntitlementSubscription = Readonly<{
  id: StringRecordId;
  billing_account: StringRecordId;
  source: QuotaSubscriptionSource;
  status: QuotaSubscriptionStatus;
  current_period_end?: DateTime;
  trial_start?: DateTime;
  trial_end?: DateTime;
  paid_through?: DateTime;
  grace_until?: DateTime;
  cancel_at_period_end?: boolean;
  cancel_at?: DateTime;
  canceled_at?: DateTime;
  expires_at?: DateTime;
}>;

export type EntitlementSubscriptionItem = Readonly<{
  id: StringRecordId;
  subscription: StringRecordId;
  workspace: StringRecordId;
  plan_revision: StringRecordId;
  status: QuotaSubscriptionItemStatus;
  effective_from: DateTime;
  effective_until?: DateTime;
}>;

export type EntitlementBaseCandidate = Readonly<{
  subscription: EntitlementSubscription;
  item: EntitlementSubscriptionItem;
  planRevision: EntitlementPlanRevision;
}>;

export type EntitlementOverrideRevision = Readonly<{
  id: StringRecordId;
  workspace: StringRecordId;
  revision: SurrealInteger;
  patches: readonly QuotaOverridePatch[];
  effective_at: DateTime;
  expires_at?: DateTime;
}>;

export type EntitlementResolutionErrorCode =
  | "invalid_candidate"
  | "overlapping_base_sources"
  | "retention_plan_required"
  | "invalid_retention_plan"
  | "duplicate_rule_key"
  | "duplicate_override_patch"
  | "unknown_override_rule"
  | "invalid_override_patch";

export class EntitlementResolutionError extends Error {
  constructor(
    readonly code: EntitlementResolutionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "EntitlementResolutionError";
  }
}

export type ResolveResourceEntitlementInput = Readonly<{
  workspace: StringRecordId;
  at: DateTime;
  previouslyActivated: boolean;
  candidates: readonly EntitlementBaseCandidate[];
  retentionPlanRevision?: EntitlementPlanRevision;
  overrideRevision?: EntitlementOverrideRevision;
  currentDesired?: Readonly<{
    id: StringRecordId;
    source_digest: string;
  }>;
  nextEntitlement: Readonly<{
    id: StringRecordId;
    revision: SurrealInteger;
  }>;
  correlationId: string;
  causationId?: string;
}>;

export type ResourceEntitlementResolution =
  | Readonly<{
      kind: "resolved";
      entitlement: ResourceEntitlementRecord;
      desiredEntitlement: StringRecordId;
    }>
  | Readonly<{
      kind: "unchanged";
      desiredEntitlement: StringRecordId;
      sourceDigest: string;
    }>
  | Readonly<{
      kind: "unresolved";
      reason: "no_eligible_source";
    }>;

type EffectiveBase = Readonly<{
  sourceType: ResourceEntitlementSourceType;
  serviceMode: QuotaServiceMode;
  subscription?: StringRecordId;
  billingAccount?: StringRecordId;
  subscriptionItem?: StringRecordId;
  planRevision: EntitlementPlanRevision;
  effectiveAt: DateTime;
  effectiveUntil?: DateTime;
}>;

function sameId(left: StringRecordId, right: StringRecordId): boolean {
  return left.toString() === right.toString();
}

function isAtOrAfter(value: DateTime, boundary: DateTime): boolean {
  return value.nanoseconds >= boundary.nanoseconds;
}

function isBefore(value: DateTime, boundary: DateTime): boolean {
  return value.nanoseconds < boundary.nanoseconds;
}

function latest(left: DateTime, right: DateTime): DateTime {
  return left.nanoseconds >= right.nanoseconds ? left : right;
}

function earliest(
  left: DateTime | undefined,
  right: DateTime | undefined,
): DateTime | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.nanoseconds <= right.nanoseconds ? left : right;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateCandidate(
  workspace: StringRecordId,
  candidate: EntitlementBaseCandidate,
): void {
  const invalidRelation =
    !sameId(candidate.item.workspace, workspace)
    || !sameId(candidate.item.subscription, candidate.subscription.id)
    || !sameId(candidate.item.plan_revision, candidate.planRevision.id);
  if (invalidRelation) {
    throw new EntitlementResolutionError(
      "invalid_candidate",
      "entitlement candidate references do not form one workspace assignment",
      {
        item: candidate.item.id.toString(),
        workspace: workspace.toString(),
      },
    );
  }
  if (
    candidate.item.effective_until
    && !isBefore(candidate.item.effective_from, candidate.item.effective_until)
  ) {
    throw new EntitlementResolutionError(
      "invalid_candidate",
      "subscription item effective_until must be after effective_from",
      { item: candidate.item.id.toString() },
    );
  }
  if (
    candidate.subscription.trial_start
    && candidate.subscription.trial_end
    && !isBefore(
      candidate.subscription.trial_start,
      candidate.subscription.trial_end,
    )
  ) {
    throw new EntitlementResolutionError(
      "invalid_candidate",
      "subscription trial_end must be after trial_start",
      { subscription: candidate.subscription.id.toString() },
    );
  }
}

function sourceType(source: QuotaSubscriptionSource): ResourceEntitlementSourceType {
  if (source === "contract") return "contract";
  if (source === "manual") return "manual";
  return "paid";
}

function effectiveCandidate(
  at: DateTime,
  candidate: EntitlementBaseCandidate,
): EffectiveBase | undefined {
  if (candidate.item.status !== "active") return undefined;
  if (!isAtOrAfter(at, candidate.item.effective_from)) return undefined;
  if (
    candidate.item.effective_until
    && !isBefore(at, candidate.item.effective_until)
  ) {
    return undefined;
  }

  const subscription = candidate.subscription;
  if (subscription.status === "trialing") {
    if (!subscription.trial_start || !subscription.trial_end) {
      throw new EntitlementResolutionError(
        "invalid_candidate",
        "trialing subscription requires trial_start and trial_end",
        { subscription: subscription.id.toString() },
      );
    }
    if (
      !isAtOrAfter(at, subscription.trial_start)
      || !isBefore(at, subscription.trial_end)
    ) {
      return undefined;
    }
    return {
      sourceType: "trial",
      serviceMode: "standard",
      subscription: subscription.id,
      billingAccount: subscription.billing_account,
      subscriptionItem: candidate.item.id,
      planRevision: candidate.planRevision,
      effectiveAt: latest(candidate.item.effective_from, subscription.trial_start),
      effectiveUntil: earliest(
        candidate.item.effective_until,
        subscription.trial_end,
      ),
    };
  }

  if (subscription.status === "past_due") {
    if (!subscription.grace_until || !isBefore(at, subscription.grace_until)) {
      return undefined;
    }
    return {
      sourceType: sourceType(subscription.source),
      serviceMode: "grace",
      subscription: subscription.id,
      billingAccount: subscription.billing_account,
      subscriptionItem: candidate.item.id,
      planRevision: candidate.planRevision,
      effectiveAt: candidate.item.effective_from,
      effectiveUntil: earliest(
        candidate.item.effective_until,
        subscription.grace_until,
      ),
    };
  }

  if (
    subscription.status === "paused"
    || subscription.status === "canceled"
    || subscription.status === "expired"
  ) {
    let effectiveUntil = earliest(
      candidate.item.effective_until,
      subscription.paid_through,
    );
    effectiveUntil = earliest(
      effectiveUntil,
      subscription.current_period_end,
    );
    effectiveUntil = earliest(effectiveUntil, subscription.cancel_at);
    effectiveUntil = earliest(effectiveUntil, subscription.expires_at);
    // canceled_at is an observation timestamp, not paid access authority. It
    // is only an immediate boundary when no explicit paid/effective end exists.
    effectiveUntil ??= subscription.canceled_at;
    if (!effectiveUntil || !isBefore(at, effectiveUntil)) return undefined;
    return {
      sourceType: sourceType(subscription.source),
      serviceMode: "standard",
      subscription: subscription.id,
      billingAccount: subscription.billing_account,
      subscriptionItem: candidate.item.id,
      planRevision: candidate.planRevision,
      effectiveAt: candidate.item.effective_from,
      effectiveUntil,
    };
  }

  if (subscription.status !== "active") return undefined;

  let effectiveUntil = earliest(
    candidate.item.effective_until,
    subscription.expires_at,
  );
  effectiveUntil = earliest(effectiveUntil, subscription.cancel_at);
  if (subscription.cancel_at_period_end) {
    if (!subscription.current_period_end) {
      throw new EntitlementResolutionError(
        "invalid_candidate",
        "cancel_at_period_end subscription requires current_period_end",
        { subscription: subscription.id.toString() },
      );
    }
    effectiveUntil = earliest(effectiveUntil, subscription.current_period_end);
  }
  if (effectiveUntil && !isBefore(at, effectiveUntil)) return undefined;

  return {
    sourceType: sourceType(subscription.source),
    serviceMode: "standard",
    subscription: subscription.id,
    billingAccount: subscription.billing_account,
    subscriptionItem: candidate.item.id,
    planRevision: candidate.planRevision,
    effectiveAt: candidate.item.effective_from,
    effectiveUntil,
  };
}

function selectBase(
  input: ResolveResourceEntitlementInput,
): EffectiveBase | undefined {
  const commercial: EffectiveBase[] = [];
  const trials: EffectiveBase[] = [];

  for (const candidate of input.candidates) {
    validateCandidate(input.workspace, candidate);
    const effective = effectiveCandidate(input.at, candidate);
    if (!effective) continue;
    (effective.sourceType === "trial" ? trials : commercial).push(effective);
  }

  const preferred = commercial.length > 0 ? commercial : trials;
  if (preferred.length > 1) {
    throw new EntitlementResolutionError(
      "overlapping_base_sources",
      "workspace has more than one effective entitlement source in the same priority tier",
      {
        workspace: input.workspace.toString(),
        subscriptionItems: preferred
          .map((source) => source.subscriptionItem?.toString())
          .filter((value): value is string => value !== undefined),
      },
    );
  }
  return preferred[0];
}

function retentionBase(
  input: ResolveResourceEntitlementInput,
): EffectiveBase | undefined {
  if (!input.previouslyActivated) return undefined;
  if (!input.retentionPlanRevision) {
    throw new EntitlementResolutionError(
      "retention_plan_required",
      "previously activated workspace requires an explicit retention plan",
      { workspace: input.workspace.toString() },
    );
  }
  if (input.retentionPlanRevision.template_kind !== "retention") {
    throw new EntitlementResolutionError(
      "invalid_retention_plan",
      "retention fallback must reference a retention plan revision",
      { planRevision: input.retentionPlanRevision.id.toString() },
    );
  }
  return {
    sourceType: "retention",
    serviceMode: "retention",
    planRevision: input.retentionPlanRevision,
    effectiveAt: input.at,
  };
}

function cloneRule(rule: ProductQuotaRule): ProductQuotaRule {
  return Object.freeze({
    rule_key: rule.rule_key,
    resource: rule.resource,
    selector: Object.freeze({ ...rule.selector }),
    limit: Object.freeze({ ...rule.limit }),
    customer_label: rule.customer_label,
    customer_description: rule.customer_description,
  });
}

function sortedRules(rules: Iterable<ProductQuotaRule>): readonly ProductQuotaRule[] {
  const cloned = Array.from(rules, cloneRule);
  const keys = new Set<string>();
  for (const rule of cloned) {
    if (keys.has(rule.rule_key)) {
      throw new EntitlementResolutionError(
        "duplicate_rule_key",
        `plan revision contains duplicate rule key: ${rule.rule_key}`,
        { ruleKey: rule.rule_key },
      );
    }
    keys.add(rule.rule_key);
  }
  return Object.freeze(
    cloned.sort((left, right) =>
      compareText(left.resource, right.resource)
      || compareText(left.rule_key, right.rule_key)
    ),
  );
}

function mergeOverride(
  baseRules: readonly ProductQuotaRule[],
  override: EntitlementOverrideRevision,
): readonly ProductQuotaRule[] {
  const rules = new Map<string, ProductQuotaRule>();
  for (const rule of baseRules) {
    if (rules.has(rule.rule_key)) {
      throw new EntitlementResolutionError(
        "duplicate_rule_key",
        `plan revision contains duplicate rule key: ${rule.rule_key}`,
        { ruleKey: rule.rule_key },
      );
    }
    rules.set(rule.rule_key, cloneRule(rule));
  }

  const patched = new Set<string>();
  for (const patch of override.patches) {
    if (patch.action !== "replace" && patch.action !== "disable") {
      throw new EntitlementResolutionError(
        "invalid_override_patch",
        `override patch has an unknown action: ${String(patch.action)}`,
        { ruleKey: patch.rule_key },
      );
    }
    if (patched.has(patch.rule_key)) {
      throw new EntitlementResolutionError(
        "duplicate_override_patch",
        `override patches the same rule more than once: ${patch.rule_key}`,
        { ruleKey: patch.rule_key },
      );
    }
    patched.add(patch.rule_key);
    const current = rules.get(patch.rule_key);
    if (!current) {
      throw new EntitlementResolutionError(
        "unknown_override_rule",
        `override references an unknown rule key: ${patch.rule_key}`,
        { ruleKey: patch.rule_key },
      );
    }
    if (patch.action === "disable") {
      rules.delete(patch.rule_key);
      continue;
    }
    if (!patch.limit && !patch.selector) {
      throw new EntitlementResolutionError(
        "invalid_override_patch",
        `replace patch must change selector or limit: ${patch.rule_key}`,
        { ruleKey: patch.rule_key },
      );
    }
    if (
      patch.selector
      && (
        !patch.selector.kind
        || patch.selector.value === undefined
      )
    ) {
      throw new EntitlementResolutionError(
        "invalid_override_patch",
        `selector replacement must include kind and value: ${patch.rule_key}`,
        { ruleKey: patch.rule_key },
      );
    }
    rules.set(patch.rule_key, cloneRule({
      ...current,
      selector: patch.selector
        ? {
            kind: patch.selector.kind as ProductQuotaRule["selector"]["kind"],
            value: patch.selector.value as string,
          }
        : current.selector,
      limit: patch.limit ?? current.limit,
    }));
  }
  return sortedRules(rules.values());
}

function activeOverride(
  input: ResolveResourceEntitlementInput,
): EntitlementOverrideRevision | undefined {
  const override = input.overrideRevision;
  if (!override) return undefined;
  if (!sameId(override.workspace, input.workspace)) {
    throw new EntitlementResolutionError(
      "invalid_candidate",
      "override belongs to a different workspace",
      { override: override.id.toString() },
    );
  }
  if (
    override.expires_at
    && !isBefore(override.effective_at, override.expires_at)
  ) {
    throw new EntitlementResolutionError(
      "invalid_candidate",
      "override expires_at must be after effective_at",
      { override: override.id.toString() },
    );
  }
  if (!isAtOrAfter(input.at, override.effective_at)) return undefined;
  if (override.expires_at && !isBefore(input.at, override.expires_at)) {
    return undefined;
  }
  return override;
}

function digestRules(rules: readonly ProductQuotaRule[]): unknown[] {
  return rules.map((rule) => ({
    rule_key: rule.rule_key,
    resource: rule.resource,
    selector: rule.selector,
    limit: rule.limit.kind === "finite"
      ? { kind: "finite", value: rule.limit.value.toString() }
      : { kind: "unlimited" },
    customer_label: rule.customer_label,
    customer_description: rule.customer_description,
  }));
}

/**
 * Pure entitlement resolver. It chooses one effective commercial source,
 * applies at most one override, and returns either a full immutable snapshot,
 * an idempotent unchanged pointer, or an explicit no-source outcome.
 */
export function resolveResourceEntitlement(
  input: ResolveResourceEntitlementInput,
): ResourceEntitlementResolution {
  const base = selectBase(input) ?? retentionBase(input);
  if (!base) {
    return Object.freeze({ kind: "unresolved", reason: "no_eligible_source" });
  }

  const override = activeOverride(input);
  const rules = override
    ? mergeOverride(base.planRevision.rules, override)
    : sortedRules(base.planRevision.rules);
  const effectiveAt = override
    ? latest(base.effectiveAt, override.effective_at)
    : base.effectiveAt;
  const effectiveUntil = earliest(base.effectiveUntil, override?.expires_at);
  const sourceDigest = canonicalSha256({
    format_version: 1,
    workspace: input.workspace.toString(),
    source_type: base.sourceType,
    service_mode: base.serviceMode,
    subscription: base.subscription?.toString(),
    billing_account: base.billingAccount?.toString(),
    subscription_item: base.subscriptionItem?.toString(),
    plan_revision: base.planRevision.id.toString(),
    override_revision: override?.id.toString(),
    source_effective_at: base.sourceType === "retention"
      ? undefined
      : effectiveAt.toString(),
    source_effective_until: effectiveUntil?.toString(),
    rules: digestRules(rules),
  });

  if (input.currentDesired?.source_digest === sourceDigest) {
    return Object.freeze({
      kind: "unchanged",
      desiredEntitlement: input.currentDesired.id,
      sourceDigest,
    });
  }

  const entitlement: ResourceEntitlementRecord = Object.freeze({
    id: input.nextEntitlement.id,
    workspace: input.workspace,
    revision: input.nextEntitlement.revision,
    source_type: base.sourceType,
    subscription_item: base.subscriptionItem,
    plan_revision: base.planRevision.id,
    override_revision: override?.id,
    service_mode: base.serviceMode,
    rules,
    source_digest: sourceDigest,
    effective_at: effectiveAt,
    effective_until: effectiveUntil,
    resolved_at: input.at,
    correlation_id: input.correlationId,
    causation_id: input.causationId,
  });
  return Object.freeze({
    kind: "resolved",
    entitlement,
    desiredEntitlement: entitlement.id,
  });
}
