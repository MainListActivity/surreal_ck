import {
  QUOTA_API_FORMAT_VERSION,
  type NativeQuotaInfo,
  type NativeQuotaLimit,
  type NativeQuotaResource,
  type NativeQuotaRule,
  type PlatformOperatorCapability,
  type QuotaApiBillingWorkspaceView,
  type QuotaApiBillingView,
  type QuotaApiBillingWorkspaceSummary,
  type QuotaApiCapability,
  type QuotaApiCustomerView,
  type QuotaApiEntitlementSummary,
  type QuotaApiOperatorView,
  type QuotaApiParticipantView,
  type QuotaApiResource,
  type QuotaApiStatuses,
  type QuotaApiSubscriptionLifecycle,
  type QuotaApiUsage,
  type QuotaApiWorkspaceView,
  type QuotaCapacityState,
  type QuotaCompliance,
  type QuotaServiceMode,
  type QuotaSubscriptionStatus,
  type QuotaSyncState,
} from "@surreal-ck/shared/native-quota";
import type { NativeQuotaClient } from "../db/native-quota/client";
import {
  QuotaInfoCache,
} from "./quota-info-cache";
import { canonicalNativePolicyDigest } from "./policy-compiler";

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

export type QuotaReadActor = Readonly<{
  subject: string;
  email?: string;
}>;

export type QuotaAuthorityRule = Readonly<{
  rule_id: string;
  rule_key: string;
  resource: NativeQuotaResource;
  selector:
    | Readonly<{ kind: "exact"; table: string }>
    | Readonly<{ kind: "regex"; pattern: string }>;
  limit: NativeQuotaLimit;
  customer_label: string;
  customer_description?: string;
}>;

export type QuotaAuthorityEntitlement = Readonly<{
  record: string;
  revision: number | bigint;
  source: "paid" | "trial" | "contract" | "manual" | "retention";
  serviceMode: QuotaServiceMode;
  effectiveAt: string;
  effectiveUntil?: string;
  planKey: string;
  planName: string;
  planRevision: number | bigint;
  adjustment?: string;
}>;

export type QuotaAuthorityProjection = Readonly<{
  record: string;
  canonicalDigest: string;
  rules: readonly QuotaAuthorityRule[];
}>;

export type QuotaAuthorityRuntime = Readonly<{
  sync: QuotaSyncState;
  compliance: QuotaCompliance;
  capacity: QuotaCapacityState;
  serviceMode: QuotaServiceMode;
  ledger: "uninitialized" | "rebuilding" | "ready" | "corrupt" | null;
  usageTrusted: boolean;
  autoReconcile: boolean;
  nativeGeneration?: number | bigint;
  nativeDigest?: string;
  lastSyncErrorCode?: string;
  updatedAt: string;
}>;

export type QuotaWorkspaceAuthority = Readonly<{
  workspace: Readonly<{
    record: string;
    slug: string;
    name: string;
    database: string;
  }>;
  workspaceRole?: "admin" | "participant";
  billingRole?: "owner" | "admin" | "viewer";
  operatorCapabilities: readonly PlatformOperatorCapability[];
  desiredEntitlement?: QuotaAuthorityEntitlement;
  appliedEntitlement?: QuotaAuthorityEntitlement;
  desiredProjection?: QuotaAuthorityProjection;
  appliedProjection?: QuotaAuthorityProjection;
  subscriptionStatus?: QuotaSubscriptionStatus;
  subscription?: QuotaApiSubscriptionLifecycle & Readonly<{
    billingAccountRecord: string;
    billingAccountKey: string;
    billingAccountName: string;
  }>;
  runtime: QuotaAuthorityRuntime;
  commercialStateAt: string;
}>;

export interface QuotaAuthorityReader {
  findWorkspaceAuthority(input: Readonly<{
    slug: string;
    actor: QuotaReadActor;
  }>): Promise<QuotaWorkspaceAuthority | null>;
  findBillingAuthority(input: Readonly<{
    accountKey: string;
    actor: QuotaReadActor;
  }>): Promise<QuotaBillingAuthority | null>;
}

export type QuotaBillingAuthority = Readonly<{
  account: Readonly<{
    accountKey: string;
    name: string;
  }>;
  workspaces: readonly QuotaWorkspaceAuthority[];
}>;

export interface QuotaObservationSink {
  observe(input: Readonly<{
    authority: QuotaWorkspaceAuthority;
    info: NativeQuotaInfo;
  }>): Promise<void>;
}

export type QuotaReadResult =
  | Readonly<{ kind: "ok"; view: QuotaApiWorkspaceView }>
  | Readonly<{ kind: "not_found" }>;

export type QuotaBillingReadResult =
  | Readonly<{ kind: "ok"; view: QuotaApiBillingView }>
  | Readonly<{ kind: "not_found" }>;

function asBigInt(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function apiCount(value: number | bigint): number | string {
  const normalized = asBigInt(value);
  return normalized <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(normalized)
    : normalized.toString();
}

function usageView(
  limit: NativeQuotaLimit,
  used: number | bigint | null,
  trusted: boolean,
): QuotaApiUsage {
  const normalizedUsed = used === null ? null : asBigInt(used);
  if (limit.kind === "unlimited") {
    return {
      kind: "unlimited",
      used: trusted && normalizedUsed !== null ? apiCount(normalizedUsed) : null,
      utilization_percent: null,
      at_limit: false,
      over_limit: false,
    };
  }

  const normalizedLimit = asBigInt(limit.value);
  if (!trusted || normalizedUsed === null) {
    return {
      kind: "finite",
      limit: apiCount(normalizedLimit),
      used: null,
      remaining: null,
      over_by: null,
      utilization_percent: null,
      at_limit: null,
      over_limit: null,
    };
  }

  const overBy =
    normalizedUsed > normalizedLimit ? normalizedUsed - normalizedLimit : 0n;
  const remaining =
    normalizedUsed < normalizedLimit ? normalizedLimit - normalizedUsed : 0n;
  const utilization =
    normalizedLimit === 0n
      ? normalizedUsed === 0n ? 100 : 101
      : Number((normalizedUsed * 10_000n) / normalizedLimit) / 100;
  return {
    kind: "finite",
    limit: apiCount(normalizedLimit),
    used: apiCount(normalizedUsed),
    remaining: apiCount(remaining),
    over_by: apiCount(overBy),
    utilization_percent: utilization,
    at_limit: normalizedUsed === normalizedLimit,
    over_limit: normalizedUsed > normalizedLimit,
  };
}

function selectorView(
  rule: QuotaAuthorityRule,
  tables: readonly string[],
  revealDetails: boolean,
): QuotaApiResource["selector"] {
  if (rule.selector.kind === "exact") {
    return {
      kind: "exact",
      description: `表 ${rule.selector.table}`,
      ...(revealDetails ? { table: rule.selector.table } : {}),
    };
  }
  return {
    kind: "regex",
    description:
      rule.customer_description ?? `匹配该资源规则的业务表`,
    ...(revealDetails
      ? {
          pattern: rule.selector.pattern,
          matched_tables: tables,
        }
      : {}),
  };
}

function nativePolicyRule(
  info: NativeQuotaInfo,
  ruleId: string,
): NativeQuotaRule | undefined {
  return info.policy?.rules.find((rule) => rule.rule_id === ruleId);
}

function resourcesFromInfo(
  authority: QuotaWorkspaceAuthority,
  info: NativeQuotaInfo,
  revealDetails: boolean,
): QuotaApiResource[] {
  const projection = authority.appliedProjection;
  if (!projection) return [];
  const trusted = info.ledger.usage_trusted && info.usage !== null;
  const resources: QuotaApiResource[] = [];

  for (const rule of projection.rules) {
    const policyRule = nativePolicyRule(info, rule.rule_id);
    const limit = policyRule?.limit ?? rule.limit;
    if (rule.resource === "table") {
      const bucket = info.usage?.table_buckets.find(
        (candidate) => candidate.rule_id === rule.rule_id,
      );
      resources.push({
        key: rule.rule_key,
        resource: rule.resource,
        label: rule.customer_label,
        ...(rule.customer_description
          ? { description: rule.customer_description }
          : {}),
        selector: selectorView(rule, [], revealDetails),
        usage: usageView(bucket?.limit ?? limit, bucket?.used ?? 0, trusted),
      });
      continue;
    }

    const usageKey: "field" | "record" = rule.resource;
    const matches = (info.usage?.tables ?? []).filter((tableUsage) => {
      const usage = tableUsage[usageKey];
      return usage.effective_rule_ids.includes(rule.rule_id);
    });
    const matchedTables = matches.map((match) => match.table).sort();

    if (matches.length === 0) {
      resources.push({
        key: rule.rule_key,
        resource: rule.resource,
        label: rule.customer_label,
        ...(rule.customer_description
          ? { description: rule.customer_description }
          : {}),
        selector: selectorView(rule, matchedTables, revealDetails),
        usage: usageView(limit, 0, trusted),
      });
      continue;
    }

    for (const match of matches) {
      const effective = match[usageKey];
      resources.push({
        key:
          rule.selector.kind === "regex"
            ? `${rule.rule_key}:${match.table}`
            : rule.rule_key,
        resource: rule.resource,
        label:
          rule.selector.kind === "regex"
            ? `${rule.customer_label} · ${match.table}`
            : rule.customer_label,
        ...(rule.customer_description
          ? { description: rule.customer_description }
          : {}),
        selector: selectorView(rule, matchedTables, revealDetails),
        usage: usageView(effective.limit, effective.used, trusted),
      });
    }
  }

  return resources;
}

function entitlementSummary(
  entitlement?: QuotaAuthorityEntitlement,
): QuotaApiEntitlementSummary | null {
  if (!entitlement) return null;
  return {
    source: entitlement.source,
    plan_key: entitlement.planKey,
    plan_name: entitlement.planName,
    plan_revision: apiCount(entitlement.planRevision),
    entitlement_revision: apiCount(entitlement.revision),
    effective_at: entitlement.effectiveAt,
    effective_until: entitlement.effectiveUntil ?? null,
    adjustment: entitlement.adjustment ?? null,
  };
}

function subscriptionSummary(
  authority: QuotaWorkspaceAuthority,
): QuotaApiSubscriptionLifecycle | null {
  const subscription = authority.subscription;
  if (!subscription) return null;
  return {
    id: subscription.id,
    source: subscription.source,
    status: subscription.status,
    current_period_end: subscription.current_period_end,
    paid_through: subscription.paid_through,
    grace_until: subscription.grace_until,
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at,
  };
}

function currentStatuses(
  authority: QuotaWorkspaceAuthority,
  info: NativeQuotaInfo,
  resources: readonly QuotaApiResource[],
): QuotaApiStatuses {
  const finite = resources.flatMap((resource) =>
    resource.usage.kind === "finite" ? [resource.usage] : []
  );
  let capacity: QuotaCapacityState;
  let compliance: QuotaCompliance;
  if (!info.ledger.usage_trusted || info.usage === null) {
    capacity = "unknown";
    compliance = "unknown";
  } else if (finite.some((usage) => usage.over_limit === true)) {
    capacity = "over_limit";
    compliance = "over_limit";
  } else if (finite.some((usage) => usage.at_limit === true)) {
    capacity = "at_limit";
    compliance = "compliant";
  } else {
    const highest = finite.reduce(
      (value, usage) =>
        Math.max(value, usage.utilization_percent ?? 0),
      0,
    );
    capacity = highest >= 90
      ? "critical"
      : highest >= 80
        ? "warning"
        : "normal";
    compliance = "compliant";
  }

  const nativeDigest = info.policy
    ? canonicalNativePolicyDigest(info.policy.rules)
    : null;
  const sync: QuotaSyncState =
    !authority.runtime.autoReconcile || authority.runtime.sync === "paused"
      ? "paused"
      : authority.appliedProjection
        && nativeDigest !== authority.appliedProjection.canonicalDigest
        ? "external_drift"
        : authority.desiredProjection?.record
          && authority.appliedProjection?.record
          && authority.desiredProjection.record
            !== authority.appliedProjection.record
          ? "pending"
          : "in_sync";

  return {
    sync,
    compliance,
    capacity,
    service_mode: authority.runtime.serviceMode,
    ledger: info.ledger.state,
  };
}

function capabilities(
  authority: QuotaWorkspaceAuthority,
): QuotaApiCapability[] {
  const result: QuotaApiCapability[] = [];
  if (authority.workspaceRole === "admin") result.push("workspace_quota.read");
  if (
    authority.billingRole === "owner"
    || authority.billingRole === "admin"
  ) {
    result.push("billing_quota.read");
  }
  if (authority.operatorCapabilities.includes("quota.read")) {
    result.push("quota.read");
  }
  return result;
}

function workspaceRef(authority: QuotaWorkspaceAuthority) {
  return {
    id: authority.workspace.record,
    slug: authority.workspace.slug,
    name: authority.workspace.name,
  };
}

function highestUtilization(resources: readonly QuotaApiResource[]): number | null {
  const values = resources.flatMap((resource) => {
    const value = resource.usage.utilization_percent;
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : Math.max(...values);
}

export class QuotaReadService {
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(
    private readonly authorityReader: QuotaAuthorityReader,
    private readonly native: NativeQuotaClient,
    private readonly cache: QuotaInfoCache,
    private readonly observationSink?: QuotaObservationSink,
    options: Readonly<{
      staleAfterMs?: number;
      now?: () => number;
    }> = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  private async recordObservation(
    authority: QuotaWorkspaceAuthority,
    info: NativeQuotaInfo,
  ): Promise<void> {
    if (!this.observationSink) return;
    try {
      await this.observationSink.observe({ authority, info });
    } catch (error) {
      // INFO remains valid for this read. The persistent native audit sweep
      // retries runtime/alert projection; do not turn an outbox failure into
      // a customer-facing quota read outage.
      console.error("[quota] failed to persist native observation", {
        workspace: authority.workspace.record,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private operatorView(
    authority: QuotaWorkspaceAuthority,
    actor: QuotaReadActor,
    info: NativeQuotaInfo,
    cacheAgeMs: number | null,
  ): QuotaApiOperatorView {
    const resources = resourcesFromInfo(authority, info, true);
    const stale =
      this.now() - Date.parse(info.observed_at) > this.staleAfterMs;
    return {
      format_version: QUOTA_API_FORMAT_VERSION,
      view: "operator",
      viewer: {
        subject: actor.subject,
        capabilities: capabilities(authority),
      },
      workspace: workspaceRef(authority),
      statuses: currentStatuses(authority, info, resources),
      observed_at: info.observed_at,
      commercial_state_at: authority.commercialStateAt,
      cache_age_ms: cacheAgeMs,
      usage_trusted: info.ledger.usage_trusted && info.usage !== null,
      stale,
      applied: entitlementSummary(authority.appliedEntitlement),
      desired: entitlementSummary(authority.desiredEntitlement),
      billing_account:
        (
          authority.billingRole === "owner"
          || authority.billingRole === "admin"
          || authority.operatorCapabilities.includes("quota.read")
        )
        && authority.subscription
          ? {
              account_key: authority.subscription.billingAccountKey,
              name: authority.subscription.billingAccountName,
              subscription: subscriptionSummary(authority)!,
            }
          : null,
      resources,
      actions: ["refresh"],
      operator: {
        capabilities: [...authority.operatorCapabilities],
        workspace_record: authority.workspace.record,
        database: authority.workspace.database,
        billing_account_record:
          authority.subscription?.billingAccountRecord ?? null,
        billing_account_key:
          authority.subscription?.billingAccountKey ?? null,
        current_subscription: authority.subscription?.id ?? null,
        desired_entitlement: authority.desiredEntitlement?.record ?? null,
        applied_entitlement: authority.appliedEntitlement?.record ?? null,
        desired_projection: authority.desiredProjection?.record ?? null,
        applied_projection: authority.appliedProjection?.record ?? null,
        native_generation:
          info.policy === null ? null : apiCount(info.policy.generation),
        native_digest:
          info.policy === null
            ? null
            : canonicalNativePolicyDigest(info.policy.rules),
        drift_error_code: authority.runtime.lastSyncErrorCode ?? null,
        auto_reconcile: authority.runtime.autoReconcile,
      },
    };
  }

  /**
   * 运营变更的服务端 preflight：绕过客户页缓存和显式刷新限速，始终直接读取
   * native INFO。调用方必须继续校验返回 workspace record 与意图目标一致。
   */
  async getOperatorWorkspaceFresh(input: Readonly<{
    slug: string;
    actor: QuotaReadActor;
  }>): Promise<QuotaApiOperatorView | null> {
    const authority = await this.authorityReader.findWorkspaceAuthority(input);
    if (
      !authority
      || !authority.operatorCapabilities.includes("quota.read")
    ) {
      return null;
    }
    const info = await this.native.info(authority.workspace.database);
    await this.recordObservation(authority, info);
    return this.operatorView(authority, input.actor, info, 0);
  }

  async getWorkspace(input: Readonly<{
    slug: string;
    actor: QuotaReadActor;
    force?: boolean;
  }>): Promise<QuotaReadResult> {
    const authority = await this.authorityReader.findWorkspaceAuthority({
      slug: input.slug,
      actor: input.actor,
    });
    if (!authority) return { kind: "not_found" };

    const canOperate = authority.operatorCapabilities.includes("quota.read");
    const canReadWorkspace = authority.workspaceRole === "admin";
    const canReadBilling =
      authority.billingRole === "owner" || authority.billingRole === "admin";
    if (
      !canOperate
      && !canReadWorkspace
      && !canReadBilling
      && authority.workspaceRole !== "participant"
    ) {
      return { kind: "not_found" };
    }

    if (
      authority.workspaceRole === "participant"
      && !canOperate
      && !canReadBilling
    ) {
      const view: QuotaApiParticipantView = {
        format_version: QUOTA_API_FORMAT_VERSION,
        view: "participant",
        viewer: { subject: input.actor.subject, capabilities: [] },
        workspace: workspaceRef(authority),
        actions: ["contact_workspace_admin"],
      };
      return { kind: "ok", view };
    }

    const cached = await this.cache.get({
      database: authority.workspace.database,
      actorSubject: input.actor.subject,
      force: input.force,
      load: () => this.native.info(authority.workspace.database),
    });
    if (!cached.fromCache) {
      await this.recordObservation(authority, cached.info);
    }

    const resources = resourcesFromInfo(
      authority,
      cached.info,
      canOperate || canReadWorkspace,
    );
    const stale =
      this.now() - Date.parse(cached.info.observed_at) > this.staleAfterMs;
    const usageTrusted =
      cached.info.ledger.usage_trusted && cached.info.usage !== null;
    const common = {
      format_version: QUOTA_API_FORMAT_VERSION,
      viewer: {
        subject: input.actor.subject,
        capabilities: capabilities(authority),
      },
      workspace: workspaceRef(authority),
      statuses: currentStatuses(authority, cached.info, resources),
      observed_at: cached.info.observed_at,
      commercial_state_at: authority.commercialStateAt,
      cache_age_ms: cached.cacheAgeMs,
    } as const;

    if (canOperate) {
      return {
        kind: "ok",
        view: this.operatorView(
          authority,
          input.actor,
          cached.info,
          cached.cacheAgeMs,
        ),
      };
    }

    if (canReadWorkspace) {
      const view: QuotaApiCustomerView = {
        ...common,
        view: "workspace_admin",
        usage_trusted: usageTrusted,
        stale,
        applied: entitlementSummary(authority.appliedEntitlement),
        desired: entitlementSummary(authority.desiredEntitlement),
        billing_account:
          canReadBilling && authority.subscription
            ? {
                account_key: authority.subscription.billingAccountKey,
                name: authority.subscription.billingAccountName,
                subscription: subscriptionSummary(authority)!,
              }
            : null,
        resources,
        actions: ["refresh"],
      };
      return { kind: "ok", view };
    }

    const view: QuotaApiBillingWorkspaceView = {
      ...common,
      view: "billing_admin",
      viewer: {
        subject: input.actor.subject,
        capabilities: ["billing_quota.read"],
      },
      plan_key: authority.appliedEntitlement?.planKey ?? null,
      plan_name: authority.appliedEntitlement?.planName ?? null,
      plan_revision:
        authority.appliedEntitlement === undefined
          ? null
          : apiCount(authority.appliedEntitlement.planRevision),
      subscription_status: authority.subscriptionStatus ?? null,
      subscription: subscriptionSummary(authority),
      utilization: {
        capacity: common.statuses.capacity,
        highest_percent: highestUtilization(resources),
        usage_trusted: usageTrusted,
        stale,
      },
      actions: ["refresh"],
    };
    return { kind: "ok", view };
  }

  async getBillingAccount(input: Readonly<{
    accountKey: string;
    actor: QuotaReadActor;
    force?: boolean;
  }>): Promise<QuotaBillingReadResult> {
    const authority = await this.authorityReader.findBillingAuthority({
      accountKey: input.accountKey,
      actor: input.actor,
    });
    if (!authority) return { kind: "not_found" };

    const summaries = await Promise.all(
      authority.workspaces.map(async (workspace): Promise<QuotaApiBillingWorkspaceSummary> => {
        const cached = await this.cache.get({
          database: workspace.workspace.database,
          actorSubject: input.actor.subject,
          force: input.force,
          load: () => this.native.info(workspace.workspace.database),
        });
        if (!cached.fromCache) {
          await this.recordObservation(workspace, cached.info);
        }
        const resources = resourcesFromInfo(workspace, cached.info, false);
        const current = currentStatuses(workspace, cached.info, resources);
        const stale =
          this.now() - Date.parse(cached.info.observed_at) > this.staleAfterMs;
        return {
          workspace: workspaceRef(workspace),
          plan_key: workspace.appliedEntitlement?.planKey ?? null,
          plan_name: workspace.appliedEntitlement?.planName ?? null,
          plan_revision:
            workspace.appliedEntitlement === undefined
              ? null
              : apiCount(workspace.appliedEntitlement.planRevision),
          subscription_status: workspace.subscriptionStatus ?? null,
          subscription: subscriptionSummary(workspace),
          statuses: current,
          utilization: {
            capacity: current.capacity,
            highest_percent: highestUtilization(resources),
            usage_trusted:
              cached.info.ledger.usage_trusted
              && cached.info.usage !== null,
            stale,
          },
        };
      }),
    );

    return {
      kind: "ok",
      view: {
        format_version: QUOTA_API_FORMAT_VERSION,
        view: "billing_admin",
        viewer: {
          subject: input.actor.subject,
          capabilities: ["billing_quota.read"],
        },
        billing_account: {
          account_key: authority.account.accountKey,
          name: authority.account.name,
        },
        workspaces: summaries,
        observed_at: new Date(this.now()).toISOString(),
        actions: ["refresh"],
      },
    };
  }
}
