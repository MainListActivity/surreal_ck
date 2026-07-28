import type {
  ControlPlaneObject,
  PlatformOperatorCapability,
  QuotaOperatorIntentKind,
  QuotaSubscriptionStatus,
  SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { canonicalSha256 } from "./canonical";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 5_000;

export class QuotaLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "QuotaLifecycleError";
  }
}

export type ProviderSubscriptionSnapshot = Readonly<{
  billingAccount: StringRecordId;
  providerCustomerId?: string;
  providerSubscriptionId: string;
  sourceRevision: SurrealInteger;
  status: QuotaSubscriptionStatus;
  currentPeriodStart?: DateTime;
  currentPeriodEnd?: DateTime;
  trialStart?: DateTime;
  trialEnd?: DateTime;
  paidThrough?: DateTime;
  graceUntil?: DateTime;
  cancelAtPeriodEnd: boolean;
  cancelAt?: DateTime;
  canceledAt?: DateTime;
  expiresAt?: DateTime;
}>;

export type ProviderSubscriptionEventInput = Readonly<{
  provider: string;
  eventId: string;
  eventType: string;
  providerObjectId?: string;
  payloadDigest: string;
  safePayload: ControlPlaneObject;
  signatureVerifiedAt: DateTime;
  receivedAt?: DateTime;
  retainUntil?: DateTime;
  correlationId: string;
  causationId?: string;
  snapshot: ProviderSubscriptionSnapshot;
}>;

export type ProviderEventClaim = Readonly<{
  event: StringRecordId;
  state: StringRecordId;
  provider: string;
  workerId: string;
  fencingToken: SurrealInteger;
  attemptNumber: SurrealInteger;
  snapshot: ProviderSubscriptionSnapshot;
  correlationId: string;
}>;

export type ProviderApplyResult = Readonly<{
  kind: "applied" | "stale_ignored";
  subscription: StringRecordId;
  providerRevision: SurrealInteger;
  workspaces: readonly StringRecordId[];
}>;

export type OperatorIntentSubmission = Readonly<{
  kind: QuotaOperatorIntentKind;
  actorSubject: string;
  actorCapability: PlatformOperatorCapability;
  requestId: string;
  workspace?: StringRecordId;
  billingAccount?: StringRecordId;
  customerReason: string;
  operatorReason: string;
  effectiveAt: DateTime;
  input: ControlPlaneObject;
  impactPreview: ControlPlaneObject;
  beforeDigest?: string;
  correlationId: string;
  causationId?: string;
}>;

export type OperatorIntentClaim = Readonly<{
  intent: StringRecordId;
  state: StringRecordId;
  kind: QuotaOperatorIntentKind;
  workspace?: StringRecordId;
  billingAccount?: StringRecordId;
  actorSubject: string;
  authorizedCapability: PlatformOperatorCapability;
  customerReason: string;
  operatorReason: string;
  effectiveAt: DateTime;
  input: ControlPlaneObject;
  requestId: string;
  correlationId: string;
  workerId: string;
  fencingToken: SurrealInteger;
  attemptNumber: SurrealInteger;
}>;

export type OperatorMutationResult = Readonly<{
  workspaces: readonly StringRecordId[];
}>;

export type EntitlementRefreshResult = Readonly<{
  entitlementOperation?: StringRecordId;
  materializationOperation?: StringRecordId;
}>;

export interface QuotaLifecycleStore {
  ingestProviderEvent(
    input: ProviderSubscriptionEventInput,
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    event: StringRecordId;
  }>>;
  claimProviderEvent(input: Readonly<{
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }>): Promise<ProviderEventClaim | undefined>;
  applyProviderSnapshot(
    claim: ProviderEventClaim,
  ): Promise<ProviderApplyResult>;
  settleProviderEvent(
    claim: ProviderEventClaim,
    result: ProviderApplyResult,
    completedAt: DateTime,
  ): Promise<boolean>;
  failProviderEvent(
    claim: ProviderEventClaim,
    failure: Readonly<{
      errorCode: string;
      errorDetails: ControlPlaneObject;
      nextAttemptAt?: DateTime;
      failedAt: DateTime;
    }>,
  ): Promise<boolean>;

  persistOperatorIntent(
    input: OperatorIntentSubmission & Readonly<{
      requiredCapability: PlatformOperatorCapability;
      inputDigest: string;
      now: DateTime;
    }>,
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    intent: StringRecordId;
  }>>;
  claimOperatorIntent(input: Readonly<{
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }>): Promise<OperatorIntentClaim | undefined>;
  applyOperatorMutation(
    claim: OperatorIntentClaim,
  ): Promise<OperatorMutationResult>;
  settleOperatorIntent(
    claim: OperatorIntentClaim,
    result: EntitlementRefreshResult,
    completedAt: DateTime,
  ): Promise<boolean>;
  failOperatorIntent(
    claim: OperatorIntentClaim,
    failure: Readonly<{
      errorCode: string;
      errorDetails: ControlPlaneObject;
      nextAttemptAt?: DateTime;
      failedAt: DateTime;
    }>,
  ): Promise<boolean>;
}

export interface EntitlementRefreshPort {
  refreshWorkspace(input: Readonly<{
    workspace: StringRecordId;
    at: DateTime;
    operationKind:
      | "provider_update"
      | "manual_assignment"
      | "plan_rollout"
      | "override_change"
      | "source_expiry";
    actorKind: "provider" | "operator" | "system";
    actorSubject?: string;
    authorizedCapability?: PlatformOperatorCapability;
    requestId?: string;
    correlationId: string;
    causationId: string;
    reason?: string;
  }>): Promise<EntitlementRefreshResult>;
}

export interface MaterializationWakePort {
  wake(): void;
}

export function requiredCapabilityForIntent(
  kind: QuotaOperatorIntentKind,
): PlatformOperatorCapability {
  if (kind === "subscription_upsert" || kind === "subscription_end") {
    return "subscription.manage";
  }
  if (kind === "override_schedule" || kind === "override_end") {
    return "override.manage";
  }
  if (kind === "drift_reapply" || kind === "drift_to_override") {
    return "drift.manage";
  }
  if (kind === "ledger_rebuild") return "ledger.rebuild";
  return "reconcile.audit";
}

function canonicalControlPlaneValue(value: unknown): unknown {
  if (value instanceof DateTime || value instanceof StringRecordId) {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(canonicalControlPlaneValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, canonicalControlPlaneValue(field)]),
    );
  }
  return value;
}

export function operatorIntentDigest(
  input: OperatorIntentSubmission,
  requiredCapability = requiredCapabilityForIntent(input.kind),
): string {
  return canonicalSha256(canonicalControlPlaneValue({
    format_version: 1,
    kind: input.kind,
    actor_subject: input.actorSubject,
    authorized_capability: requiredCapability,
    workspace: input.workspace,
    billing_account: input.billingAccount,
    customer_reason: input.customerReason,
    operator_reason: input.operatorReason,
    effective_at: input.effectiveAt,
    input: input.input,
    impact_preview: input.impactPreview,
    before_digest: input.beforeDigest,
  }));
}

function addMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(
    value.nanoseconds + BigInt(milliseconds) * 1_000_000n,
  );
}

function errorDetails(error: unknown): Readonly<{
  code: string;
  retryable: boolean;
  details: ControlPlaneObject;
}> {
  if (error instanceof QuotaLifecycleError) {
    return {
      code: error.code,
      retryable: error.retryable,
      details: Object.freeze({ error_name: error.name }),
    };
  }
  return {
    code: "quota_lifecycle_processing_failed",
    retryable: true,
    details: Object.freeze({
      error_name: error instanceof Error ? error.name : typeof error,
    }),
  };
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new QuotaLifecycleError(
      "operator_intent_invalid",
      `${field} is required`,
    );
  }
}

function operationKindForIntent(
  claim: OperatorIntentClaim,
): Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0]["operationKind"] {
  if (claim.kind === "override_schedule" || claim.kind === "override_end") {
    return "override_change";
  }
  const mode = claim.input.mode;
  if (mode === "plan_rollout" || mode === "payer_switch") {
    return "plan_rollout";
  }
  if (claim.kind === "subscription_end") return "source_expiry";
  return "manual_assignment";
}

export class QuotaLifecycleCoordinator {
  private readonly clock: Readonly<{ now(): DateTime }>;
  private readonly leaseDurationMs: number;
  private readonly retryMs: number;

  constructor(
    private readonly store: QuotaLifecycleStore,
    private readonly refresher: EntitlementRefreshPort,
    private readonly workerId: string,
    private readonly wakePort?: MaterializationWakePort,
    options: Readonly<{
      clock?: Readonly<{ now(): DateTime }>;
      leaseDurationMs?: number;
      retryMs?: number;
    }> = {},
  ) {
    this.clock = options.clock ?? { now: () => DateTime.now() };
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  ingestProviderEvent(
    input: ProviderSubscriptionEventInput,
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    event: StringRecordId;
  }>> {
    assertNonEmpty(input.provider, "provider");
    assertNonEmpty(input.eventId, "eventId");
    assertNonEmpty(input.payloadDigest, "payloadDigest");
    if (BigInt(input.snapshot.sourceRevision) < 0n) {
      throw new QuotaLifecycleError(
        "provider_revision_invalid",
        "provider source revision must be non-negative",
      );
    }
    return this.store.ingestProviderEvent(input);
  }

  async submitOperatorIntent(
    input: OperatorIntentSubmission,
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    intent: StringRecordId;
  }>> {
    assertNonEmpty(input.actorSubject, "actorSubject");
    assertNonEmpty(input.requestId, "requestId");
    assertNonEmpty(input.customerReason, "customerReason");
    assertNonEmpty(input.operatorReason, "operatorReason");
    assertNonEmpty(input.correlationId, "correlationId");
    const requiredCapability = requiredCapabilityForIntent(input.kind);
    if (input.actorCapability !== requiredCapability) {
      throw new QuotaLifecycleError(
        "operator_capability_mismatch",
        `intent ${input.kind} requires ${requiredCapability}`,
      );
    }
    return await this.store.persistOperatorIntent({
      ...input,
      requiredCapability,
      inputDigest: operatorIntentDigest(input, requiredCapability),
      now: this.clock.now(),
    });
  }

  async processNextProviderEvent(): Promise<
    "idle" | "processed" | "stale_ignored" | "retry_scheduled" | "failed"
  > {
    const now = this.clock.now();
    const claim = await this.store.claimProviderEvent({
      workerId: this.workerId,
      now,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claim) return "idle";
    try {
      const applied = await this.store.applyProviderSnapshot(claim);
      for (const workspace of applied.workspaces) {
        await this.refresher.refreshWorkspace({
          workspace,
          at: now,
          operationKind: "provider_update",
          actorKind: "provider",
          correlationId: claim.correlationId,
          causationId: claim.event.toString(),
        });
      }
      const settled = await this.store.settleProviderEvent(
        claim,
        applied,
        this.clock.now(),
      );
      if (!settled) return "failed";
      if (applied.kind === "applied" && applied.workspaces.length > 0) {
        this.wakePort?.wake();
      }
      return applied.kind === "stale_ignored"
        ? "stale_ignored"
        : "processed";
    } catch (error) {
      const failure = errorDetails(error);
      await this.store.failProviderEvent(claim, {
        errorCode: failure.code,
        errorDetails: failure.details,
        nextAttemptAt: failure.retryable
          ? addMilliseconds(this.clock.now(), this.retryMs)
          : undefined,
        failedAt: this.clock.now(),
      });
      return failure.retryable ? "retry_scheduled" : "failed";
    }
  }

  async processNextOperatorIntent(): Promise<
    "idle" | "processed" | "retry_scheduled" | "failed"
  > {
    const now = this.clock.now();
    const claim = await this.store.claimOperatorIntent({
      workerId: this.workerId,
      now,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claim) return "idle";
    try {
      const mutation = await this.store.applyOperatorMutation(claim);
      let refreshResult: EntitlementRefreshResult = {};
      for (const workspace of mutation.workspaces) {
        refreshResult = await this.refresher.refreshWorkspace({
          workspace,
          at: claim.effectiveAt,
          operationKind: operationKindForIntent(claim),
          actorKind: "operator",
          actorSubject: claim.actorSubject,
          authorizedCapability: claim.authorizedCapability,
          requestId: claim.requestId,
          correlationId: claim.correlationId,
          causationId: claim.intent.toString(),
        });
      }
      const settled = await this.store.settleOperatorIntent(
        claim,
        refreshResult,
        this.clock.now(),
      );
      if (!settled) return "failed";
      if (mutation.workspaces.length > 0) this.wakePort?.wake();
      return "processed";
    } catch (error) {
      const failure = errorDetails(error);
      await this.store.failOperatorIntent(claim, {
        errorCode: failure.code,
        errorDetails: failure.details,
        nextAttemptAt: failure.retryable
          ? addMilliseconds(this.clock.now(), this.retryMs)
          : undefined,
        failedAt: this.clock.now(),
      });
      return failure.retryable ? "retry_scheduled" : "failed";
    }
  }
}
