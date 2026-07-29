import {
  QUOTA_API_FORMAT_VERSION,
  type ControlPlaneObject,
  type PlatformOperatorCapability,
  type QuotaApiCount,
  type QuotaApiOperatorView,
  type QuotaApiResource,
  type QuotaOperatorIntentKind,
  type QuotaOpsImpactResource,
  type QuotaOpsIntentPreflightView,
  type QuotaOpsPlanRule,
} from "@surreal-ck/shared/native-quota";
import { StringRecordId } from "surrealdb";
import type {
  QuotaOpsConsoleActor,
  QuotaOpsConsolePort,
} from "./quota-ops-console";
import {
  requiredCapabilityForIntent,
} from "./subscription-lifecycle";
import type { QuotaReadActor } from "./quota-read-service";

export interface QuotaOpsFreshReadPort {
  getOperatorWorkspaceFresh(input: Readonly<{
    slug: string;
    actor: QuotaReadActor;
  }>): Promise<QuotaApiOperatorView | null>;
}

export interface QuotaOpsPreflightPort {
  preflight(input: Readonly<{
    actor: QuotaReadActor;
    workspaceSlug: string;
    workspace: StringRecordId;
    kind: QuotaOperatorIntentKind;
    effectiveAt: string;
    intentInput: ControlPlaneObject;
  }>): Promise<QuotaOpsIntentPreflightView | null>;
}

function asBigInt(value: QuotaApiCount): bigint {
  return BigInt(value);
}

function apiCount(value: bigint): QuotaApiCount {
  return value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function usageLimit(
  resource: QuotaApiResource,
): QuotaApiCount | "unlimited" {
  return resource.usage.kind === "unlimited"
    ? "unlimited"
    : resource.usage.limit;
}

function selector(resource: QuotaApiResource): string {
  if (resource.selector.kind === "exact") {
    return resource.selector.table
      ? `固定表 ${resource.selector.table}`
      : resource.selector.description;
  }
  return resource.selector.pattern
    ? `正则 ${resource.selector.pattern}`
    : resource.selector.description;
}

function baseRuleKey(resource: QuotaApiResource): string {
  if (resource.selector.kind !== "regex") return resource.key;
  const table = resource.selector.matched_tables?.find((candidate) =>
    resource.key.endsWith(`:${candidate}`)
  );
  return table
    ? resource.key.slice(0, -(table.length + 1))
    : resource.key;
}

function matchesPlanRule(
  resource: QuotaApiResource,
  rule: QuotaOpsPlanRule,
): boolean {
  if (resource.resource !== rule.resource) return false;
  if (rule.selector.kind === "exact") {
    return resource.selector.kind === "exact"
      && resource.selector.table === rule.selector.value;
  }
  return resource.selector.kind === "regex"
    && resource.selector.pattern === rule.selector.value;
}

function projectedOverBy(
  used: QuotaApiCount | null,
  target: QuotaApiCount | "unlimited" | null,
): QuotaApiCount | null {
  if (used === null || target === null || target === "unlimited") return null;
  const difference = asBigInt(used) - asBigInt(target);
  return apiCount(difference > 0n ? difference : 0n);
}

function currentImpact(
  resource: QuotaApiResource,
  target: QuotaApiCount | "unlimited" | null = usageLimit(resource),
): QuotaOpsImpactResource {
  return {
    key: resource.key,
    label: resource.label,
    resource: resource.resource,
    selector: selector(resource),
    current_limit: usageLimit(resource),
    target_limit: target,
    used: resource.usage.used,
    projected_over_by: projectedOverBy(resource.usage.used, target),
  };
}

function planImpact(
  resources: readonly QuotaApiResource[],
  rules: readonly QuotaOpsPlanRule[],
): QuotaOpsImpactResource[] {
  const consumed = new Set<string>();
  const impact: QuotaOpsImpactResource[] = [];
  for (const rule of rules) {
    const matches = resources.filter((resource) =>
      matchesPlanRule(resource, rule)
    );
    const target =
      rule.limit.kind === "unlimited" ? "unlimited" : rule.limit.value;
    if (matches.length === 0) {
      impact.push({
        key: rule.rule_key,
        label: rule.label,
        resource: rule.resource,
        selector:
          rule.selector.kind === "exact"
            ? `固定表 ${rule.selector.value}`
            : `正则 ${rule.selector.value}`,
        current_limit: null,
        target_limit: target,
        used: null,
        projected_over_by: null,
      });
      continue;
    }
    for (const resource of matches) {
      consumed.add(resource.key);
      impact.push(currentImpact(resource, target));
    }
  }
  for (const resource of resources) {
    if (!consumed.has(resource.key)) impact.push(currentImpact(resource, null));
  }
  return impact;
}

function overrideImpact(
  resources: readonly QuotaApiResource[],
  intentInput: ControlPlaneObject,
): QuotaOpsImpactResource[] {
  const patches = Array.isArray(intentInput.patches)
    ? intentInput.patches.filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
    : [];
  return resources.map((resource) => {
    const patch = patches.find((candidate) =>
      candidate.rule_key === baseRuleKey(resource)
    );
    if (!patch) return currentImpact(resource);
    if (patch.action === "disable") return currentImpact(resource, null);
    const limit =
      typeof patch.limit === "object"
        && patch.limit !== null
        && !Array.isArray(patch.limit)
        ? patch.limit as Record<string, unknown>
        : null;
    if (limit?.kind === "unlimited") {
      return currentImpact(resource, "unlimited");
    }
    if (
      limit?.kind === "finite"
      && (
        typeof limit.value === "string"
        || (
          typeof limit.value === "number"
          && Number.isSafeInteger(limit.value)
        )
      )
    ) {
      return currentImpact(resource, limit.value);
    }
    return currentImpact(resource, null);
  });
}

function affectedCapabilities(kind: QuotaOperatorIntentKind): string[] {
  if (kind === "subscription_upsert" || kind === "subscription_end") {
    return ["commercial entitlement", "service mode", "native quota policy"];
  }
  if (kind === "override_schedule" || kind === "override_end") {
    return ["quota adjustment", "native quota policy"];
  }
  if (kind === "ledger_rebuild") {
    return ["quota ledger", "usage availability"];
  }
  if (kind === "auto_reconcile_pause" || kind === "auto_reconcile_resume") {
    return ["automatic reconciliation"];
  }
  return ["quota reconciliation", "native readback"];
}

function targetPlanId(intentInput: ControlPlaneObject): StringRecordId | null {
  if (
    typeof intentInput.plan_revision !== "string"
    || !intentInput.plan_revision.startsWith("quota_plan_revision:")
  ) {
    return null;
  }
  try {
    return new StringRecordId(intentInput.plan_revision);
  } catch {
    return null;
  }
}

function intentTargetsCurrentState(
  fresh: QuotaApiOperatorView,
  kind: QuotaOperatorIntentKind,
  intentInput: ControlPlaneObject,
): boolean {
  if (kind !== "subscription_end") return true;
  const status = intentInput.status;
  return typeof intentInput.subscription === "string"
    && intentInput.subscription === fresh.operator.current_subscription
    && (
      status === "paused"
      || status === "canceled"
      || status === "expired"
    );
}

export class QuotaOpsPreflightService implements QuotaOpsPreflightPort {
  constructor(
    private readonly reads: QuotaOpsFreshReadPort,
    private readonly console: QuotaOpsConsolePort,
  ) {}

  async preflight(input: Readonly<{
    actor: QuotaReadActor;
    workspaceSlug: string;
    workspace: StringRecordId;
    kind: QuotaOperatorIntentKind;
    effectiveAt: string;
    intentInput: ControlPlaneObject;
  }>): Promise<QuotaOpsIntentPreflightView | null> {
    const fresh = await this.reads.getOperatorWorkspaceFresh({
      slug: input.workspaceSlug,
      actor: input.actor,
    });
    if (
      !fresh
      || fresh.operator.workspace_record !== input.workspace.toString()
      || fresh.observed_at === null
    ) {
      return null;
    }
    const requiredCapability = requiredCapabilityForIntent(input.kind);
    if (!fresh.operator.capabilities.includes(requiredCapability)) return null;
    if (!intentTargetsCurrentState(fresh, input.kind, input.intentInput)) {
      return null;
    }

    const planId = input.kind === "subscription_upsert"
      ? targetPlanId(input.intentInput)
      : null;
    const plan = planId
      ? await this.console.findPlanRevision({
          actor: input.actor satisfies QuotaOpsConsoleActor,
          id: planId,
        })
      : null;
    if (
      input.kind === "subscription_upsert"
      && (
        !plan
        || (
          plan.template_kind !== "commercial"
          && plan.template_kind !== "contract"
        )
      )
    ) {
      return null;
    }

    const resources =
      plan
        ? planImpact(fresh.resources, plan.rules)
        : input.kind === "override_schedule"
          || input.kind === "drift_to_override"
          ? overrideImpact(fresh.resources, input.intentInput)
          : fresh.resources.map((resource) => currentImpact(resource));
    const overageCount = resources.filter((resource) =>
      resource.projected_over_by !== null
      && asBigInt(resource.projected_over_by) > 0n
    ).length;

    return {
      format_version: QUOTA_API_FORMAT_VERSION,
      workspace: fresh.workspace,
      kind: input.kind,
      required_capability: requiredCapability satisfies PlatformOperatorCapability,
      observed_at: fresh.observed_at,
      usage_trusted: fresh.usage_trusted,
      stale: false,
      effective_at: input.effectiveAt,
      current_plan: fresh.applied,
      target_plan: plan
        ? {
            id: plan.id,
            plan_key: plan.plan_key,
            plan_name: plan.plan_name,
            revision: plan.revision,
          }
        : null,
      resources,
      overage_count: overageCount,
      affected_capabilities: affectedCapabilities(input.kind),
      before_digest: fresh.operator.native_digest,
    };
  }
}
