import {
  NATIVE_QUOTA_EXPECTED_CONTRACT,
  extractNativeQuotaError,
  type ControlPlaneObject,
  type NativeQuotaInfo,
  type NativeQuotaOperationResult,
  type QuotaMaterializationAttemptOutcome,
  type QuotaPolicyProjectionRecord,
  type SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import type { DateTime, StringRecordId } from "surrealdb";
import { DateTime as SurrealDateTime } from "surrealdb";
import type { NativeQuotaClient } from "../db/native-quota/client";
import { canonicalNativePolicyDigest } from "./policy-compiler";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const RETRYABLE_NATIVE_CODES = new Set([
  "quota_conflict",
  "quota_policy_changed",
  "quota_ledger_unavailable",
]);
const TERMINAL_NATIVE_CODES = new Set([
  "quota_policy_invalid",
  "quota_policy_exists",
  "quota_policy_not_found",
  "quota_rule_not_found",
  "quota_unauthorized",
  "iam_not_allowed",
]);

export type AppliedQuotaState = Readonly<{
  entitlement: StringRecordId;
  projection: StringRecordId;
  canonicalDigest: string;
  nativeGeneration?: SurrealInteger;
}>;

export type MaterializationLease = Readonly<{
  operation: StringRecordId;
  workspace: StringRecordId;
  database: string;
  entitlement: StringRecordId;
  projection: QuotaPolicyProjectionRecord;
  desiredEntitlement: StringRecordId;
  desiredProjection: StringRecordId;
  applied?: AppliedQuotaState;
  workspaceStatus: "provisioning" | "active" | "provisioning_error";
  autoReconcile: boolean;
  allowExternalDriftOverwrite: boolean;
  executionStarted: boolean;
  workerId: string;
  fencingToken: SurrealInteger;
  attemptNumber: SurrealInteger;
  startedAt: DateTime;
  leaseExpiresAt: DateTime;
  correlationId: string;
}>;

type SettlementBase = Readonly<{
  outcome: QuotaMaterializationAttemptOutcome;
  completedAt: DateTime;
  observedBeforeGeneration?: SurrealInteger;
  observedBeforeDigest?: string;
  nativeOperationId?: string;
  observedAfterGeneration?: SurrealInteger;
  observedAfterDigest?: string;
  ledgerState?: NativeQuotaInfo["ledger"]["state"];
  usageTrusted?: boolean;
  errorCode?: string;
  errorRetryable?: boolean;
  errorDetails?: ControlPlaneObject;
}>;

export type MaterializationSettlement =
  | (SettlementBase & Readonly<{
      kind: "succeeded";
      outcome: "succeeded";
    }>)
  | (SettlementBase & Readonly<{
      kind: "retry";
      outcome: "retryable_error" | "commit_unknown";
      nextAttemptAt: DateTime;
      exhausted: boolean;
    }>)
  | (SettlementBase & Readonly<{
      kind: "terminal";
      outcome: "terminal_error";
      syncState: "error" | "external_drift";
    }>)
  | (SettlementBase & Readonly<{
      kind: "superseded";
      outcome: "superseded";
      supersededBy?: StringRecordId;
    }>)
  | (SettlementBase & Readonly<{
      kind: "lease_lost";
      outcome: "lease_lost";
    }>);

export interface QuotaMaterializationStore {
  renewMaterializationLease(
    lease: MaterializationLease,
    now: DateTime,
    leaseDurationMs: number,
  ): Promise<boolean>;
  settleMaterialization(
    lease: MaterializationLease,
    settlement: MaterializationSettlement,
  ): Promise<"committed" | "lease_lost">;
}

export type QuotaReconcileResult = Readonly<{
  kind:
    | "succeeded"
    | "retry_scheduled"
    | "failed"
    | "external_drift"
    | "superseded"
    | "lease_lost";
  operation: StringRecordId;
  ddlExecuted: boolean;
  rebuilt: boolean;
  errorCode?: string;
}>;

export type QuotaReconcilerOptions = Readonly<{
  leaseDurationMs?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  clock?: Readonly<{ now(): DateTime }>;
  random?: () => number;
}>;

type Observation = Readonly<{
  info: NativeQuotaInfo;
  generation?: SurrealInteger;
  digest?: string;
}>;

function numericEquals(
  left: SurrealInteger | undefined,
  right: SurrealInteger | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return BigInt(left) === BigInt(right);
}

function sameId(left: StringRecordId, right: StringRecordId): boolean {
  return left.toString() === right.toString();
}

function addMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return SurrealDateTime.fromEpochNanoseconds(
    value.nanoseconds + BigInt(Math.round(milliseconds)) * 1_000_000n,
  );
}

function durationMilliseconds(start: DateTime, end: DateTime): number {
  const elapsed = end.nanoseconds - start.nanoseconds;
  return Number(elapsed > 0n ? elapsed / 1_000_000n : 0n);
}

function observe(info: NativeQuotaInfo): Observation {
  return Object.freeze({
    info,
    generation: info.policy?.generation,
    digest: info.policy
      ? canonicalNativePolicyDigest(info.policy.rules)
      : undefined,
  });
}

function errorObject(
  error: unknown,
  phase: string,
): Readonly<{
  code: string;
  retryable: boolean;
  details: ControlPlaneObject;
  structured: boolean;
  incompatible: boolean;
}> {
  const envelope = extractNativeQuotaError(error);
  if (envelope) {
    return {
      code: envelope.code,
      retryable: envelope.retryable,
      details: Object.freeze({ phase, ...envelope.details }),
      structured: true,
      incompatible: false,
    };
  }
  const errorName = error instanceof Error ? error.name : typeof error;
  return {
    code: errorName === "ZodError"
      ? "native_quota_contract_incompatible"
      : "native_quota_transport_error",
    retryable: errorName !== "ZodError",
    details: Object.freeze({ phase, error_name: errorName }),
    structured: false,
    incompatible: errorName === "ZodError",
  };
}

function operationId(result: NativeQuotaOperationResult | undefined): string | undefined {
  return result?.operation_id;
}

function isReady(info: NativeQuotaInfo): boolean {
  return (
    info.ledger.state === "ready"
    && info.ledger.usage_trusted
    && info.usage !== null
  );
}

function projectionCompatible(projection: QuotaPolicyProjectionRecord): boolean {
  return (
    projection.native_capability === NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName
    && BigInt(projection.native_contract_major)
      === BigInt(NATIVE_QUOTA_EXPECTED_CONTRACT.quotaContractMajor)
    && BigInt(projection.info_format_version)
      === BigInt(NATIVE_QUOTA_EXPECTED_CONTRACT.infoFormatVersion)
  );
}

function result(
  lease: MaterializationLease,
  kind: QuotaReconcileResult["kind"],
  ddlExecuted: boolean,
  rebuilt: boolean,
  errorCode?: string,
): QuotaReconcileResult {
  return Object.freeze({
    kind,
    operation: lease.operation,
    ddlExecuted,
    rebuilt,
    errorCode,
  });
}

export class QuotaReconciler {
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly clock: Readonly<{ now(): DateTime }>;
  private readonly random: () => number;

  constructor(
    private readonly store: QuotaMaterializationStore,
    private readonly native: NativeQuotaClient,
    options: QuotaReconcilerOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.clock = options.clock ?? { now: () => SurrealDateTime.now() };
    this.random = options.random ?? Math.random;
  }

  async reconcile(lease: MaterializationLease): Promise<QuotaReconcileResult> {
    if (
      !sameId(lease.projection.id, lease.desiredProjection)
      && !lease.executionStarted
    ) {
      const completedAt = this.clock.now();
      await this.store.settleMaterialization(lease, {
        kind: "superseded",
        outcome: "superseded",
        supersededBy: lease.desiredProjection,
        completedAt,
      });
      return result(lease, "superseded", false, false);
    }
    if (!lease.autoReconcile && !lease.allowExternalDriftOverwrite) {
      return this.terminal(
        lease,
        "quota_auto_reconcile_paused",
        false,
        { workspace: lease.workspace.toString() },
        "error",
        false,
        false,
      );
    }
    if (!projectionCompatible(lease.projection)) {
      return this.terminal(
        lease,
        "native_quota_contract_incompatible",
        false,
        {
          capability: lease.projection.native_capability,
          contract_major: lease.projection.native_contract_major,
          info_format_version: lease.projection.info_format_version,
        },
        "error",
        false,
        false,
      );
    }

    let before: Observation;
    try {
      before = observe(await this.native.info(lease.database));
    } catch (error) {
      return this.failBeforeMutation(lease, error, "info_before");
    }
    if (
      before.info.database !== lease.database
      || BigInt(before.info.format_version)
        !== BigInt(lease.projection.info_format_version)
    ) {
      return this.terminal(
        lease,
        "native_quota_contract_incompatible",
        false,
        {
          expected_database: lease.database,
          observed_database: before.info.database,
          expected_info_format: lease.projection.info_format_version,
          observed_info_format: before.info.format_version,
        },
        "error",
        false,
        false,
        before,
      );
    }

    let current = before;
    let rebuilt = false;
    let nativeResult: NativeQuotaOperationResult | undefined;
    if (!isReady(current.info)) {
      if (current.info.ledger.state === "rebuilding") {
        return this.retry(
          lease,
          "quota_ledger_rebuilding",
          true,
          { ledger_state: current.info.ledger.state },
          "retryable_error",
          false,
          rebuilt,
          before,
          current,
        );
      }
      if (
        current.info.ledger.state !== "uninitialized"
        && current.info.ledger.state !== "corrupt"
      ) {
        return this.terminal(
          lease,
          "quota_ledger_unavailable",
          false,
          { ledger_state: current.info.ledger.state },
          "error",
          false,
          rebuilt,
          before,
          current,
        );
      }
      const renewed = await this.store.renewMaterializationLease(
        lease,
        this.clock.now(),
        this.leaseDurationMs,
      );
      if (!renewed) return this.leaseLost(lease, before, current, false, rebuilt);
      try {
        nativeResult = await this.native.rebuild(lease.database);
        rebuilt = true;
      } catch (error) {
        rebuilt = true;
        return this.recoverAfterMutation(
          lease,
          error,
          "rebuild",
          before,
          false,
          rebuilt,
        );
      }
      try {
        current = observe(await this.native.info(lease.database));
      } catch (error) {
        return this.retryFromError(
          lease,
          error,
          "info_after_rebuild",
          "commit_unknown",
          false,
          rebuilt,
          before,
          undefined,
          operationId(nativeResult),
        );
      }
      if (!isReady(current.info)) {
        return this.retry(
          lease,
          "quota_ledger_unavailable",
          true,
          { ledger_state: current.info.ledger.state },
          "retryable_error",
          false,
          rebuilt,
          before,
          current,
          operationId(nativeResult),
        );
      }
    }

    const targetDigest = lease.projection.canonical_digest;
    if (current.digest === targetDigest) {
      return this.succeed(
        lease,
        before,
        current,
        operationId(nativeResult) ?? current.info.latest_change?.operation_id,
        false,
        rebuilt,
      );
    }

    const drift = this.detectDrift(lease, current);
    if (drift && !lease.allowExternalDriftOverwrite) {
      return this.terminal(
        lease,
        "external_drift",
        false,
        drift,
        "external_drift",
        false,
        rebuilt,
        before,
        current,
      );
    }

    const renewed = await this.store.renewMaterializationLease(
      lease,
      this.clock.now(),
      this.leaseDurationMs,
    );
    if (!renewed) return this.leaseLost(lease, before, current, false, rebuilt);

    const expectedGeneration = current.info.policy
      ? current.info.policy.generation
      : undefined;
    try {
      nativeResult = await this.native.applyPolicy({
        database: lease.database,
        rules: lease.projection.rules,
        expectedGeneration,
      });
    } catch (error) {
      return this.recoverAfterMutation(
        lease,
        error,
        "apply_policy",
        before,
        true,
        rebuilt,
        current,
      );
    }

    let after: Observation;
    try {
      after = observe(await this.native.info(lease.database));
    } catch (error) {
      return this.retryFromError(
        lease,
        error,
        "info_after_apply",
        "commit_unknown",
        true,
        rebuilt,
        before,
        undefined,
        operationId(nativeResult),
      );
    }
    if (after.digest !== targetDigest || !isReady(after.info)) {
      const afterDrift = this.detectDrift(lease, after);
      if (afterDrift && after.digest !== targetDigest) {
        return this.terminal(
          lease,
          "external_drift",
          false,
          afterDrift,
          "external_drift",
          true,
          rebuilt,
          before,
          after,
          operationId(nativeResult),
        );
      }
      return this.retry(
        lease,
        "native_readback_mismatch",
        true,
        {
          expected_digest: targetDigest,
          observed_digest: after.digest,
          ledger_state: after.info.ledger.state,
          usage_trusted: after.info.ledger.usage_trusted,
        },
        "retryable_error",
        true,
        rebuilt,
        before,
        after,
        operationId(nativeResult),
      );
    }
    return this.succeed(
      lease,
      before,
      after,
      operationId(nativeResult),
      true,
      rebuilt,
    );
  }

  private detectDrift(
    lease: MaterializationLease,
    observation: Observation,
  ): ControlPlaneObject | undefined {
    if (!observation.info.policy) return undefined;
    if (!lease.applied) {
      return Object.freeze({
        reason: "unexpected_existing_policy",
        observed_digest: observation.digest,
        observed_generation: observation.generation,
      });
    }
    const digestChanged = observation.digest !== lease.applied.canonicalDigest;
    const generationChanged = (
      lease.applied.nativeGeneration !== undefined
      && !numericEquals(observation.generation, lease.applied.nativeGeneration)
    );
    if (!digestChanged && !generationChanged) return undefined;
    return Object.freeze({
      reason: "applied_policy_changed_outside_control_plane",
      applied_digest: lease.applied.canonicalDigest,
      applied_generation: lease.applied.nativeGeneration,
      observed_digest: observation.digest,
      observed_generation: observation.generation,
    });
  }

  private async recoverAfterMutation(
    lease: MaterializationLease,
    error: unknown,
    phase: string,
    before: Observation,
    ddlExecuted: boolean,
    rebuilt: boolean,
    mutationObservation?: Observation,
  ): Promise<QuotaReconcileResult> {
    const classified = errorObject(error, phase);
    let after: Observation | undefined;
    try {
      after = observe(await this.native.info(lease.database));
    } catch {
      return this.retry(
        lease,
        classified.code,
        classified.retryable || !classified.structured,
        classified.details,
        "commit_unknown",
        ddlExecuted,
        rebuilt,
        before,
        undefined,
      );
    }

    if (
      after.digest === lease.projection.canonical_digest
      && isReady(after.info)
    ) {
      return this.succeed(
        lease,
        before,
        after,
        after.info.latest_change?.operation_id,
        ddlExecuted,
        rebuilt,
      );
    }

    const drift = this.detectDrift(lease, after);
    const unchangedSinceMutationStart = (
      after.digest === mutationObservation?.digest
      && numericEquals(after.generation, mutationObservation?.generation)
    );
    if (drift && !unchangedSinceMutationStart) {
      return this.terminal(
        lease,
        "external_drift",
        false,
        drift,
        "external_drift",
        ddlExecuted,
        rebuilt,
        before,
        after,
      );
    }
    if (
      classified.incompatible
      || (
        TERMINAL_NATIVE_CODES.has(classified.code)
        && !classified.retryable
      )
    ) {
      return this.terminal(
        lease,
        classified.code,
        false,
        classified.details,
        "error",
        ddlExecuted,
        rebuilt,
        before,
        after,
      );
    }
    const retryable = (
      classified.retryable
      || RETRYABLE_NATIVE_CODES.has(classified.code)
      || !classified.structured
    );
    if (!retryable) {
      return this.terminal(
        lease,
        classified.code,
        false,
        classified.details,
        "error",
        ddlExecuted,
        rebuilt,
        before,
        after,
      );
    }
    return this.retry(
      lease,
      classified.code,
      true,
      classified.details,
      classified.structured ? "retryable_error" : "commit_unknown",
      ddlExecuted,
      rebuilt,
      before,
      after,
    );
  }

  private async failBeforeMutation(
    lease: MaterializationLease,
    error: unknown,
    phase: string,
  ): Promise<QuotaReconcileResult> {
    const classified = errorObject(error, phase);
    if (classified.incompatible) {
      return this.terminal(
        lease,
        classified.code,
        false,
        classified.details,
        "error",
        false,
        false,
      );
    }
    return this.retry(
      lease,
      classified.code,
      classified.retryable,
      classified.details,
      "retryable_error",
      false,
      false,
    );
  }

  private async retryFromError(
    lease: MaterializationLease,
    error: unknown,
    phase: string,
    outcome: "retryable_error" | "commit_unknown",
    ddlExecuted: boolean,
    rebuilt: boolean,
    before?: Observation,
    after?: Observation,
    nativeOperationId?: string,
  ): Promise<QuotaReconcileResult> {
    const classified = errorObject(error, phase);
    return this.retry(
      lease,
      classified.code,
      true,
      classified.details,
      outcome,
      ddlExecuted,
      rebuilt,
      before,
      after,
      nativeOperationId,
    );
  }

  private async succeed(
    lease: MaterializationLease,
    before: Observation,
    after: Observation,
    nativeOperationId: string | undefined,
    ddlExecuted: boolean,
    rebuilt: boolean,
  ): Promise<QuotaReconcileResult> {
    const completedAt = this.clock.now();
    const settled = await this.store.settleMaterialization(lease, {
      kind: "succeeded",
      outcome: "succeeded",
      completedAt,
      observedBeforeGeneration: before.generation,
      observedBeforeDigest: before.digest,
      nativeOperationId,
      observedAfterGeneration: after.generation,
      observedAfterDigest: after.digest,
      ledgerState: after.info.ledger.state,
      usageTrusted: after.info.ledger.usage_trusted,
    });
    return settled === "lease_lost"
      ? result(lease, "lease_lost", ddlExecuted, rebuilt, "lease_lost")
      : result(lease, "succeeded", ddlExecuted, rebuilt);
  }

  private async retry(
    lease: MaterializationLease,
    code: string,
    retryable: boolean,
    details: ControlPlaneObject,
    outcome: "retryable_error" | "commit_unknown",
    ddlExecuted: boolean,
    rebuilt: boolean,
    before?: Observation,
    after?: Observation,
    nativeOperationId?: string,
  ): Promise<QuotaReconcileResult> {
    if (!retryable) {
      return this.terminal(
        lease,
        code,
        false,
        details,
        "error",
        ddlExecuted,
        rebuilt,
        before,
        after,
        nativeOperationId,
      );
    }
    const completedAt = this.clock.now();
    const attempts = Number(lease.attemptNumber);
    const exhausted = attempts >= this.maxAttempts;
    const exponent = Math.max(0, attempts - 1);
    const base = Math.min(1_000 * 2 ** exponent, this.maxBackoffMs);
    const jitter = 0.75 + Math.min(1, Math.max(0, this.random())) * 0.5;
    const nextAttemptAt = addMilliseconds(completedAt, base * jitter);
    const settled = await this.store.settleMaterialization(lease, {
      kind: "retry",
      outcome,
      completedAt,
      observedBeforeGeneration: before?.generation,
      observedBeforeDigest: before?.digest,
      nativeOperationId,
      observedAfterGeneration: after?.generation,
      observedAfterDigest: after?.digest,
      ledgerState: after?.info.ledger.state ?? before?.info.ledger.state,
      usageTrusted:
        after?.info.ledger.usage_trusted
        ?? before?.info.ledger.usage_trusted,
      errorCode: code,
      errorRetryable: true,
      errorDetails: Object.freeze({
        ...details,
        duration_ms: durationMilliseconds(lease.startedAt, completedAt),
      }),
      nextAttemptAt,
      exhausted,
    });
    if (settled === "lease_lost") {
      return result(lease, "lease_lost", ddlExecuted, rebuilt, "lease_lost");
    }
    return result(
      lease,
      exhausted ? "failed" : "retry_scheduled",
      ddlExecuted,
      rebuilt,
      code,
    );
  }

  private async terminal(
    lease: MaterializationLease,
    code: string,
    retryable: boolean,
    details: ControlPlaneObject,
    syncState: "error" | "external_drift",
    ddlExecuted: boolean,
    rebuilt: boolean,
    before?: Observation,
    after?: Observation,
    nativeOperationId?: string,
  ): Promise<QuotaReconcileResult> {
    const completedAt = this.clock.now();
    const settled = await this.store.settleMaterialization(lease, {
      kind: "terminal",
      outcome: "terminal_error",
      completedAt,
      observedBeforeGeneration: before?.generation,
      observedBeforeDigest: before?.digest,
      nativeOperationId,
      observedAfterGeneration: after?.generation,
      observedAfterDigest: after?.digest,
      ledgerState: after?.info.ledger.state ?? before?.info.ledger.state,
      usageTrusted:
        after?.info.ledger.usage_trusted
        ?? before?.info.ledger.usage_trusted,
      errorCode: code,
      errorRetryable: retryable,
      errorDetails: Object.freeze({
        ...details,
        duration_ms: durationMilliseconds(lease.startedAt, completedAt),
      }),
      syncState,
    });
    if (settled === "lease_lost") {
      return result(lease, "lease_lost", ddlExecuted, rebuilt, "lease_lost");
    }
    return result(
      lease,
      syncState === "external_drift" ? "external_drift" : "failed",
      ddlExecuted,
      rebuilt,
      code,
    );
  }

  private async leaseLost(
    lease: MaterializationLease,
    before: Observation,
    after: Observation,
    ddlExecuted: boolean,
    rebuilt: boolean,
  ): Promise<QuotaReconcileResult> {
    await this.store.settleMaterialization(lease, {
      kind: "lease_lost",
      outcome: "lease_lost",
      completedAt: this.clock.now(),
      observedBeforeGeneration: before.generation,
      observedBeforeDigest: before.digest,
      observedAfterGeneration: after.generation,
      observedAfterDigest: after.digest,
      ledgerState: after.info.ledger.state,
      usageTrusted: after.info.ledger.usage_trusted,
      errorCode: "lease_lost",
      errorRetryable: true,
      errorDetails: Object.freeze({ fencing_token: lease.fencingToken }),
    });
    return result(lease, "lease_lost", ddlExecuted, rebuilt, "lease_lost");
  }
}
