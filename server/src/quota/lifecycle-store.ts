import {
  omitNullishSurrealFields,
} from "@surreal-ck/shared";
import type {
  ControlPlaneObject,
  PlatformOperatorCapability,
  QuotaOperatorIntentKind,
  QuotaOverridePatch,
  QuotaSubscriptionStatus,
  SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { toStringRecordId } from "../db/surreal-values";
import { stableSha256 } from "./canonical";
import {
  QuotaLifecycleError,
  type EntitlementRefreshResult,
  type OperatorIntentClaim,
  type OperatorIntentSubmission,
  type OperatorMutationResult,
  type ProviderApplyResult,
  type ProviderEventClaim,
  type ProviderSubscriptionEventInput,
  type ProviderSubscriptionSnapshot,
  type QuotaLifecycleStore,
} from "./subscription-lifecycle";

export type QuotaLifecycleQueryClient = Readonly<{
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultValues(result: unknown): unknown[] {
  return Array.isArray(result) ? result : [];
}

function nestedRecords(value: unknown): UnknownRecord[] {
  if (isRecord(value)) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(nestedRecords);
}

function lastRecord(result: unknown): UnknownRecord | undefined {
  const records = nestedRecords(result);
  return records.at(-1);
}

function lastBoolean(result: unknown): boolean | undefined {
  const values = resultValues(result);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      for (let nestedIndex = value.length - 1; nestedIndex >= 0; nestedIndex -= 1) {
        if (typeof value[nestedIndex] === "boolean") {
          return value[nestedIndex] as boolean;
        }
      }
    }
  }
  return undefined;
}

function firstStatementRow(result: unknown): UnknownRecord | undefined {
  const statement = resultValues(result)[0];
  if (Array.isArray(statement)) {
    return statement.find(isRecord);
  }
  return isRecord(statement) ? statement : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new QuotaLifecycleError(
      "lifecycle_state_invalid",
      `invalid ${field}`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredRecordId(value: unknown, field: string): StringRecordId {
  const id = toStringRecordId(value);
  if (!id) {
    throw new QuotaLifecycleError(
      "lifecycle_state_invalid",
      `invalid ${field} record id`,
    );
  }
  return id;
}

function optionalRecordId(value: unknown): StringRecordId | undefined {
  return toStringRecordId(value) ?? undefined;
}

function requiredDateTime(value: unknown, field: string): DateTime {
  if (value instanceof DateTime) return value;
  if (value instanceof Date) return new DateTime(value.toISOString());
  if (typeof value === "string") return new DateTime(value);
  throw new QuotaLifecycleError(
    "lifecycle_state_invalid",
    `invalid ${field} datetime`,
  );
}

function optionalDateTime(value: unknown): DateTime | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredDateTime(value, "optional");
}

function integer(value: unknown, field: string): SurrealInteger {
  if (
    typeof value === "bigint"
    || (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  throw new QuotaLifecycleError(
    "lifecycle_state_invalid",
    `invalid ${field} integer`,
  );
}

function deterministicId(
  table: string,
  ...identity: readonly string[]
): StringRecordId {
  return new StringRecordId(
    `${table}:q_${stableSha256(identity.join("\0")).slice(0, 28)}`,
  );
}

function addMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(
    value.nanoseconds + BigInt(milliseconds) * 1_000_000n,
  );
}

function snapshotObject(
  snapshot: ProviderSubscriptionSnapshot,
): ControlPlaneObject {
  return omitNullishSurrealFields({
    billing_account: snapshot.billingAccount,
    provider_customer_id: snapshot.providerCustomerId,
    provider_subscription_id: snapshot.providerSubscriptionId,
    source_revision: snapshot.sourceRevision,
    status: snapshot.status,
    current_period_start: snapshot.currentPeriodStart,
    current_period_end: snapshot.currentPeriodEnd,
    trial_start: snapshot.trialStart,
    trial_end: snapshot.trialEnd,
    paid_through: snapshot.paidThrough,
    grace_until: snapshot.graceUntil,
    cancel_at_period_end: snapshot.cancelAtPeriodEnd,
    cancel_at: snapshot.cancelAt,
    canceled_at: snapshot.canceledAt,
    expires_at: snapshot.expiresAt,
  });
}

function snapshotFromEvent(row: UnknownRecord): ProviderSubscriptionSnapshot {
  const safePayload = row.safe_payload;
  if (!isRecord(safePayload) || !isRecord(safePayload.normalized_subscription)) {
    throw new QuotaLifecycleError(
      "provider_snapshot_invalid",
      "provider event has no normalized subscription snapshot",
    );
  }
  const snapshot = safePayload.normalized_subscription;
  const status = requiredString(snapshot.status, "subscription status");
  if (
    status !== "pending"
    && status !== "trialing"
    && status !== "active"
    && status !== "past_due"
    && status !== "paused"
    && status !== "canceled"
    && status !== "expired"
  ) {
    throw new QuotaLifecycleError(
      "provider_snapshot_invalid",
      `unknown subscription status: ${status}`,
    );
  }
  return Object.freeze({
    billingAccount: requiredRecordId(
      snapshot.billing_account,
      "billing account",
    ),
    providerCustomerId: optionalString(snapshot.provider_customer_id),
    providerSubscriptionId: requiredString(
      snapshot.provider_subscription_id,
      "provider subscription",
    ),
    sourceRevision: integer(snapshot.source_revision, "provider source revision"),
    status: status as QuotaSubscriptionStatus,
    currentPeriodStart: optionalDateTime(snapshot.current_period_start),
    currentPeriodEnd: optionalDateTime(snapshot.current_period_end),
    trialStart: optionalDateTime(snapshot.trial_start),
    trialEnd: optionalDateTime(snapshot.trial_end),
    paidThrough: optionalDateTime(snapshot.paid_through),
    graceUntil: optionalDateTime(snapshot.grace_until),
    cancelAtPeriodEnd: snapshot.cancel_at_period_end === true,
    cancelAt: optionalDateTime(snapshot.cancel_at),
    canceledAt: optionalDateTime(snapshot.canceled_at),
    expiresAt: optionalDateTime(snapshot.expires_at),
  });
}

function recordIds(value: unknown): StringRecordId[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(optionalRecordId)
    .filter((item): item is StringRecordId => item !== undefined);
}

function inputRecordId(
  input: ControlPlaneObject,
  field: string,
  fallback?: StringRecordId,
): StringRecordId {
  return fallback ?? requiredRecordId(input[field], field);
}

function inputString(
  input: ControlPlaneObject,
  field: string,
): string {
  return requiredString(input[field], field);
}

export class SurrealQuotaLifecycleStore implements QuotaLifecycleStore {
  constructor(private readonly db: QuotaLifecycleQueryClient) {}

  async ingestProviderEvent(
    input: ProviderSubscriptionEventInput,
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    event: StringRecordId;
  }>> {
    const event = deterministicId(
      "provider_event_inbox",
      input.provider,
      input.eventId,
    );
    const state = deterministicId(
      "provider_event_state",
      input.provider,
      input.eventId,
    );
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $existing = (
          SELECT *
          FROM provider_event_inbox
          WHERE provider = $provider AND event_id = $eventId
          LIMIT 1
        )[0];
        IF $existing != NONE
          AND $existing.payload_digest != $payloadDigest {
          THROW "provider-event-idempotency-conflict";
        };
        IF $existing = NONE {
          CREATE $event CONTENT $eventContent;
          CREATE $state CONTENT {
            provider_event: $event,
            state: "pending",
            attempt_count: 0,
            fencing_token: 0
          };
        };
        RETURN {
          event: IF $existing = NONE { $event } ELSE { $existing.id },
          accepted: $existing = NONE
        };
        COMMIT TRANSACTION;
      `,
      {
        provider: input.provider,
        eventId: input.eventId,
        payloadDigest: input.payloadDigest,
        event,
        state,
        eventContent: omitNullishSurrealFields({
          provider: input.provider,
          event_id: input.eventId,
          event_type: input.eventType,
          provider_object_id: input.providerObjectId,
          payload_digest: input.payloadDigest,
          safe_payload: {
            provider_payload: input.safePayload,
            normalized_subscription: snapshotObject(input.snapshot),
          },
          signature_verified_at: input.signatureVerifiedAt,
          received_at: input.receivedAt,
          retain_until: input.retainUntil,
          correlation_id: input.correlationId,
          causation_id: input.causationId,
        }),
      },
    );
    const row = lastRecord(result);
    if (!row) {
      throw new QuotaLifecycleError(
        "provider_event_persist_failed",
        "provider event insert returned no result",
        true,
      );
    }
    return Object.freeze({
      kind: row.accepted === true ? "accepted" : "duplicate",
      event: requiredRecordId(row.event, "provider event"),
    });
  }

  async claimProviderEvent(input: {
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }): Promise<ProviderEventClaim | undefined> {
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $candidate = (
          SELECT *
          FROM provider_event_state
          WHERE (
            state = "pending"
            OR (
              state = "failed"
              AND (next_attempt_at = NONE OR next_attempt_at <= $now)
            )
            OR (
              state = "processing"
              AND (lease_expires_at = NONE OR lease_expires_at <= $now)
            )
          )
          ORDER BY updated_at ASC
          LIMIT 1
        )[0];
        LET $claimed = IF $candidate != NONE {
          (
            UPDATE $candidate.id
            SET
              state = "processing",
              attempt_count += 1,
              lease_owner = $worker,
              lease_expires_at = $leaseExpiresAt,
              fencing_token += 1,
              last_error_code = NONE,
              last_error_details = NONE
            RETURN AFTER
          )[0]
        } ELSE {
          NONE
        };
        RETURN $claimed;
        COMMIT TRANSACTION;
      `,
      {
        worker: input.workerId,
        now: input.now,
        leaseExpiresAt: addMilliseconds(input.now, input.leaseDurationMs),
      },
    );
    const claimed = lastRecord(result);
    if (!claimed) return undefined;
    const event = requiredRecordId(claimed.provider_event, "provider event");
    const eventResult = await this.db.query(
      "SELECT * FROM ONLY $event;",
      { event },
    );
    const eventRow = firstStatementRow(eventResult);
    if (!eventRow) {
      throw new QuotaLifecycleError(
        "provider_event_missing",
        "claimed provider event does not exist",
      );
    }
    return Object.freeze({
      event,
      state: requiredRecordId(claimed.id, "provider event state"),
      provider: requiredString(eventRow.provider, "provider"),
      workerId: input.workerId,
      fencingToken: integer(claimed.fencing_token, "provider fencing token"),
      attemptNumber: integer(claimed.attempt_count, "provider attempt"),
      snapshot: snapshotFromEvent(eventRow),
      correlationId: requiredString(
        eventRow.correlation_id,
        "provider correlation id",
      ),
    });
  }

  async applyProviderSnapshot(
    claim: ProviderEventClaim,
  ): Promise<ProviderApplyResult> {
    const snapshot = claim.snapshot;
    const subscription = deterministicId(
      "quota_subscription",
      claim.provider,
      snapshot.providerSubscriptionId,
    );
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $state = SELECT * FROM ONLY $state;
        LET $owns = $state != NONE
          AND $state.state = "processing"
          AND $state.lease_owner = $worker
          AND $state.fencing_token = $fencingToken;
        IF !$owns {
          THROW "provider-event-lease-lost";
        };
        LET $existing = (
          SELECT *
          FROM quota_subscription
          WHERE provider = $provider
            AND provider_subscription_id = $providerSubscriptionId
          LIMIT 1
        )[0];
        LET $replayed = $state.applied_provider_revision = $sourceRevision
          AND $state.applied_subscription != NONE;
        LET $stale = !$replayed
          AND $existing != NONE
          AND $existing.provider_source_revision != NONE
          AND $existing.provider_source_revision >= $sourceRevision;
        IF !$replayed AND !$stale {
          IF $existing = NONE {
            CREATE $subscription CONTENT {
              billing_account: $billingAccount,
              source: "provider",
              status: $status,
              revision: 1,
              provider: $provider,
              provider_customer_id: $providerCustomerId,
              provider_subscription_id: $providerSubscriptionId,
              provider_source_revision: $sourceRevision,
              current_period_start: $currentPeriodStart,
              current_period_end: $currentPeriodEnd,
              trial_start: $trialStart,
              trial_end: $trialEnd,
              paid_through: $paidThrough,
              grace_until: $graceUntil,
              cancel_at_period_end: $cancelAtPeriodEnd,
              cancel_at: $cancelAt,
              canceled_at: $canceledAt,
              expires_at: $expiresAt,
              correlation_id: $correlationId,
              causation_id: $event
            };
          } ELSE {
            UPDATE $existing.id SET
              billing_account = $billingAccount,
              status = $status,
              revision += 1,
              provider_customer_id = $providerCustomerId,
              provider_source_revision = $sourceRevision,
              current_period_start = $currentPeriodStart,
              current_period_end = $currentPeriodEnd,
              trial_start = $trialStart,
              trial_end = $trialEnd,
              paid_through = $paidThrough,
              grace_until = $graceUntil,
              cancel_at_period_end = $cancelAtPeriodEnd,
              cancel_at = $cancelAt,
              canceled_at = $canceledAt,
              expires_at = $expiresAt,
              correlation_id = $correlationId,
              causation_id = $event;
          };
          UPDATE $state.id SET
            applied_subscription = IF $existing = NONE {
              $subscription
            } ELSE {
              $existing.id
            },
            applied_provider_revision = $sourceRevision;
        };
        LET $target = IF $existing = NONE { $subscription } ELSE { $existing.id };
        LET $workspaces = SELECT VALUE workspace
          FROM quota_subscription_item
          WHERE subscription = $target AND status = "active";
        RETURN {
          kind: IF $stale { "stale_ignored" } ELSE { "applied" },
          subscription: $target,
          provider_revision: $sourceRevision,
          workspaces: $workspaces
        };
        COMMIT TRANSACTION;
      `,
      {
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        provider: claim.provider,
        providerSubscriptionId: snapshot.providerSubscriptionId,
        sourceRevision: snapshot.sourceRevision,
        subscription,
        billingAccount: snapshot.billingAccount,
        status: snapshot.status,
        providerCustomerId: snapshot.providerCustomerId,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        trialStart: snapshot.trialStart,
        trialEnd: snapshot.trialEnd,
        paidThrough: snapshot.paidThrough,
        graceUntil: snapshot.graceUntil,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        cancelAt: snapshot.cancelAt,
        canceledAt: snapshot.canceledAt,
        expiresAt: snapshot.expiresAt,
        correlationId: claim.correlationId,
        event: claim.event.toString(),
      },
    );
    const row = lastRecord(result);
    if (!row) {
      throw new QuotaLifecycleError(
        "provider_snapshot_apply_failed",
        "provider snapshot apply returned no result",
        true,
      );
    }
    return Object.freeze({
      kind: row.kind === "stale_ignored" ? "stale_ignored" : "applied",
      subscription: requiredRecordId(row.subscription, "subscription"),
      providerRevision: integer(
        row.provider_revision,
        "provider revision",
      ),
      workspaces: Object.freeze(recordIds(row.workspaces)),
    });
  }

  async settleProviderEvent(
    claim: ProviderEventClaim,
    result: ProviderApplyResult,
    completedAt: DateTime,
  ): Promise<boolean> {
    const audit = deterministicId(
      "quota_audit_event",
      claim.event.toString(),
      result.kind,
    );
    const queryResult = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $state;
        LET $owns = $current != NONE
          AND $current.state = "processing"
          AND $current.lease_owner = $worker
          AND $current.fencing_token = $fencingToken;
        IF $owns {
          UPDATE $state SET
            state = $terminalState,
            lease_owner = NONE,
            lease_expires_at = NONE,
            next_attempt_at = NONE,
            last_error_code = NONE,
            last_error_details = NONE,
            processed_at = $completedAt;
          IF !record::exists($audit) {
            CREATE $audit CONTENT {
              event_kind: $eventKind,
              provider_event: $event,
              actor_kind: "provider",
              before_reference: NONE,
              after_reference: $subscriptionReference,
              after_digest: $providerRevision,
              correlation_id: $correlationId,
              causation_id: $eventCausation,
              applied_at: $completedAt,
              occurred_at: $completedAt
            };
          };
        };
        RETURN $owns;
        COMMIT TRANSACTION;
      `,
      {
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        terminalState:
          result.kind === "stale_ignored" ? "stale_ignored" : "processed",
        completedAt,
        audit,
        eventKind:
          result.kind === "stale_ignored"
            ? "subscription.provider_event.stale_ignored"
            : "subscription.provider_event.applied",
        event: claim.event,
        eventCausation: claim.event.toString(),
        subscriptionReference: result.subscription.toString(),
        providerRevision: result.providerRevision.toString(),
        correlationId: claim.correlationId,
      },
    );
    return lastBoolean(queryResult) === true;
  }

  async failProviderEvent(
    claim: ProviderEventClaim,
    failure: {
      errorCode: string;
      errorDetails: ControlPlaneObject;
      nextAttemptAt?: DateTime;
      failedAt: DateTime;
    },
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE $state SET
          state = $failureState,
          lease_owner = NONE,
          lease_expires_at = NONE,
          next_attempt_at = $nextAttemptAt,
          last_error_code = $errorCode,
          last_error_details = $errorDetails,
          processed_at = IF $failureState = "ignored" {
            $failedAt
          } ELSE {
            processed_at
          }
        WHERE state = "processing"
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
        RETURN AFTER;
      `,
      {
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        failureState: failure.nextAttemptAt ? "failed" : "ignored",
        nextAttemptAt: failure.nextAttemptAt,
        errorCode: failure.errorCode,
        errorDetails: failure.errorDetails,
        failedAt: failure.failedAt,
      },
    );
    return firstStatementRow(result) !== undefined;
  }

  async persistOperatorIntent(
    input: OperatorIntentSubmission & {
      requiredCapability: PlatformOperatorCapability;
      inputDigest: string;
      now: DateTime;
    },
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    intent: StringRecordId;
  }>> {
    const intent = deterministicId(
      "quota_operator_intent",
      input.requestId,
    );
    const state = deterministicId(
      "quota_operator_intent_state",
      input.requestId,
    );
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $operator = (
          SELECT *
          FROM platform_operator
          WHERE subject = $actorSubject AND status = "active"
          LIMIT 1
        )[0];
        IF $operator = NONE {
          THROW "operator-not-authorized";
        };
        LET $capability = (
          SELECT *
          FROM platform_operator_capability
          WHERE operator = $operator.id
            AND capability = $requiredCapability
            AND status = "active"
          LIMIT 1
        )[0];
        IF $capability = NONE {
          THROW "operator-capability-denied";
        };
        LET $existing = (
          SELECT *
          FROM quota_operator_intent
          WHERE request_id = $requestId
          LIMIT 1
        )[0];
        IF $existing != NONE
          AND $existing.input_digest != $inputDigest {
          THROW "operator-intent-idempotency-conflict";
        };
        IF $existing = NONE {
          CREATE $intent CONTENT {
            intent_kind: $intentKind,
            workspace: $workspace,
            billing_account: $billingAccount,
            operator: $operator.id,
            actor_subject: $actorSubject,
            authorized_capability: $requiredCapability,
            request_id: $requestId,
            customer_reason: $customerReason,
            operator_reason: $operatorReason,
            effective_at: $effectiveAt,
            input: $input,
            input_digest: $inputDigest,
            impact_preview: $impactPreview,
            before_digest: $beforeDigest,
            correlation_id: $correlationId,
            causation_id: $causationId
          };
          CREATE $state CONTENT {
            intent: $intent,
            state: IF $effectiveAt > $now { "scheduled" } ELSE { "pending" },
            attempt_count: 0,
            next_attempt_at: $effectiveAt,
            fencing_token: 0
          };
        };
        RETURN {
          intent: IF $existing = NONE { $intent } ELSE { $existing.id },
          accepted: $existing = NONE
        };
        COMMIT TRANSACTION;
      `,
      {
        actorSubject: input.actorSubject,
        requiredCapability: input.requiredCapability,
        requestId: input.requestId,
        inputDigest: input.inputDigest,
        intent,
        state,
        effectiveAt: input.effectiveAt,
        now: input.now,
        intentKind: input.kind,
        workspace: input.workspace,
        billingAccount: input.billingAccount,
        customerReason: input.customerReason,
        operatorReason: input.operatorReason,
        input: input.input,
        impactPreview: input.impactPreview,
        beforeDigest: input.beforeDigest,
        correlationId: input.correlationId,
        causationId: input.causationId,
      },
    );
    const row = lastRecord(result);
    if (!row) {
      throw new QuotaLifecycleError(
        "operator_intent_persist_failed",
        "operator intent insert returned no result",
        true,
      );
    }
    return Object.freeze({
      kind: row.accepted === true ? "accepted" : "duplicate",
      intent: requiredRecordId(row.intent, "operator intent"),
    });
  }

  async claimOperatorIntent(input: {
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }): Promise<OperatorIntentClaim | undefined> {
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $candidate = (
          SELECT *
          FROM quota_operator_intent_state
          WHERE (
            state INSIDE ["scheduled", "pending", "failed"]
            AND (next_attempt_at = NONE OR next_attempt_at <= $now)
          ) OR (
            state = "processing"
            AND (lease_expires_at = NONE OR lease_expires_at <= $now)
          )
          ORDER BY updated_at ASC
          LIMIT 1
        )[0];
        LET $claimed = IF $candidate != NONE {
          (
            UPDATE $candidate.id
            SET
              state = "processing",
              attempt_count += 1,
              lease_owner = $worker,
              lease_expires_at = $leaseExpiresAt,
              fencing_token += 1,
              last_error_code = NONE,
              last_error_details = NONE
            RETURN AFTER
          )[0]
        } ELSE {
          NONE
        };
        RETURN $claimed;
        COMMIT TRANSACTION;
      `,
      {
        worker: input.workerId,
        now: input.now,
        leaseExpiresAt: addMilliseconds(input.now, input.leaseDurationMs),
      },
    );
    const claimed = lastRecord(result);
    if (!claimed) return undefined;
    const intent = requiredRecordId(claimed.intent, "operator intent");
    const intentResult = await this.db.query(
      "SELECT * FROM ONLY $intent;",
      { intent },
    );
    const intentRow = firstStatementRow(intentResult);
    if (!intentRow) {
      throw new QuotaLifecycleError(
        "operator_intent_missing",
        "claimed operator intent does not exist",
      );
    }
    return Object.freeze({
      intent,
      state: requiredRecordId(claimed.id, "operator intent state"),
      kind: requiredString(
        intentRow.intent_kind,
        "operator intent kind",
      ) as QuotaOperatorIntentKind,
      workspace: optionalRecordId(intentRow.workspace),
      billingAccount: optionalRecordId(intentRow.billing_account),
      actorSubject: requiredString(
        intentRow.actor_subject,
        "operator actor",
      ),
      authorizedCapability: requiredString(
        intentRow.authorized_capability,
        "operator capability",
      ) as PlatformOperatorCapability,
      customerReason: requiredString(
        intentRow.customer_reason,
        "customer reason",
      ),
      operatorReason: requiredString(
        intentRow.operator_reason,
        "operator reason",
      ),
      effectiveAt: requiredDateTime(
        intentRow.effective_at,
        "operator effective_at",
      ),
      input: isRecord(intentRow.input) ? intentRow.input : {},
      requestId: requiredString(intentRow.request_id, "operator request"),
      correlationId: requiredString(
        intentRow.correlation_id,
        "operator correlation",
      ),
      workerId: input.workerId,
      fencingToken: integer(claimed.fencing_token, "operator fencing token"),
      attemptNumber: integer(claimed.attempt_count, "operator attempt"),
    });
  }

  async applyOperatorMutation(
    claim: OperatorIntentClaim,
  ): Promise<OperatorMutationResult> {
    await this.assertOperatorLease(claim);
    if (claim.kind === "subscription_upsert") {
      return await this.applySubscriptionUpsert(claim);
    }
    if (claim.kind === "subscription_end") {
      return await this.applySubscriptionEnd(claim);
    }
    if (
      claim.kind === "override_schedule"
      || claim.kind === "drift_to_override"
    ) {
      return await this.applyOverrideSchedule(claim);
    }
    if (claim.kind === "override_end") {
      return await this.applyOverrideEnd(claim);
    }
    if (
      claim.kind === "auto_reconcile_pause"
      || claim.kind === "auto_reconcile_resume"
    ) {
      const workspace = inputRecordId(
        claim.input,
        "workspace",
        claim.workspace,
      );
      await this.db.query(
        `
          BEGIN TRANSACTION;
          LET $intentState = SELECT * FROM ONLY $state;
          IF $intentState = NONE
            OR $intentState.state != "processing"
            OR $intentState.lease_owner != $worker
            OR $intentState.fencing_token != $fencingToken {
            THROW "operator-intent-lease-lost";
          };
          UPDATE workspace_quota_runtime
          SET
            auto_reconcile = $enabled,
            sync_state = IF $enabled { "pending" } ELSE { "paused" }
          WHERE workspace = $workspace;
          UPDATE $state SET affected_workspaces = [$workspace];
          COMMIT TRANSACTION;
        `,
        {
          state: claim.state,
          worker: claim.workerId,
          fencingToken: claim.fencingToken,
          workspace,
          enabled: claim.kind === "auto_reconcile_resume",
        },
      );
      return Object.freeze({ workspaces: Object.freeze([]) });
    }
    if (
      claim.kind === "materialization_retry"
      || claim.kind === "drift_reapply"
      || claim.kind === "reconcile_now"
    ) {
      const workspace = inputRecordId(
        claim.input,
        "workspace",
        claim.workspace,
      );
      await this.db.query(
        `
          BEGIN TRANSACTION;
          LET $intentState = SELECT * FROM ONLY $state;
          IF $intentState = NONE
            OR $intentState.state != "processing"
            OR $intentState.lease_owner != $worker
            OR $intentState.fencing_token != $fencingToken {
            THROW "operator-intent-lease-lost";
          };
          LET $operation = (
            SELECT *
            FROM quota_materialization_operation
            WHERE workspace = $workspace
              AND status = "failed"
            ORDER BY updated_at DESC
            LIMIT 1
          )[0];
          IF $operation != NONE {
            UPDATE $operation.id SET
              status = "pending",
              reconcile_mode = $mode,
              next_attempt_at = time::now(),
              last_error_code = NONE,
              last_error_retryable = NONE,
              last_error_details = NONE;
          };
          UPDATE workspace_quota_runtime SET
            sync_state = "pending",
            auto_reconcile = true
          WHERE workspace = $workspace;
          UPDATE $state SET affected_workspaces = [$workspace];
          COMMIT TRANSACTION;
        `,
        {
          state: claim.state,
          worker: claim.workerId,
          fencingToken: claim.fencingToken,
          workspace,
          mode:
            claim.kind === "drift_reapply" ? "drift_reapply" : "normal",
        },
      );
      return Object.freeze({ workspaces: Object.freeze([workspace]) });
    }
    if (claim.kind === "audit_now") {
      const workspace = inputRecordId(
        claim.input,
        "workspace",
        claim.workspace,
      );
      return Object.freeze({ workspaces: Object.freeze([workspace]) });
    }
    if (claim.kind === "ledger_rebuild") {
      const workspace = inputRecordId(
        claim.input,
        "workspace",
        claim.workspace,
      );
      await this.db.query(
        `
          BEGIN TRANSACTION;
          LET $intentState = SELECT * FROM ONLY $state;
          IF $intentState = NONE
            OR $intentState.state != "processing"
            OR $intentState.lease_owner != $worker
            OR $intentState.fencing_token != $fencingToken {
            THROW "operator-intent-lease-lost";
          };
          UPDATE $state SET affected_workspaces = [$workspace];
          COMMIT TRANSACTION;
        `,
        {
          state: claim.state,
          worker: claim.workerId,
          fencingToken: claim.fencingToken,
          workspace,
        },
      );
      return Object.freeze({ workspaces: Object.freeze([workspace]) });
    }
    throw new QuotaLifecycleError(
      "operator_intent_not_executable",
      `operator intent ${claim.kind} requires its dedicated executor`,
    );
  }

  private async assertOperatorLease(
    claim: OperatorIntentClaim,
  ): Promise<void> {
    const result = await this.db.query(
      `
        SELECT VALUE
          state = "processing"
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
        FROM ONLY $state;
      `,
      {
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
      },
    );
    const statement = resultValues(result)[0];
    const owns = Array.isArray(statement) ? statement[0] : statement;
    if (owns !== true) {
      throw new QuotaLifecycleError(
        "operator_intent_lease_lost",
        "operator intent lease was lost",
        true,
      );
    }
  }

  private async applySubscriptionUpsert(
    claim: OperatorIntentClaim,
  ): Promise<OperatorMutationResult> {
    const workspace = inputRecordId(
      claim.input,
      "workspace",
      claim.workspace,
    );
    const billingAccount = inputRecordId(
      claim.input,
      "billing_account",
      claim.billingAccount,
    );
    const planRevision = requiredRecordId(
      claim.input.plan_revision,
      "plan revision",
    );
    const mode = inputString(claim.input, "mode");
    if (
      mode !== "manual_assignment"
      && mode !== "contract_assignment"
      && mode !== "plan_rollout"
      && mode !== "payer_switch"
    ) {
      throw new QuotaLifecycleError(
        "operator_intent_invalid",
        `invalid subscription upsert mode: ${mode}`,
      );
    }
    const requestedSubscription = optionalRecordId(claim.input.subscription);
    const source = optionalString(claim.input.source);
    if (
      mode !== "plan_rollout"
      && source !== "manual"
      && source !== "contract"
    ) {
      throw new QuotaLifecycleError(
        "operator_intent_invalid",
        "manual/contract assignment requires a matching source",
      );
    }
    const status = optionalString(claim.input.status) ?? "active";
    if (status !== "active" && status !== "trialing") {
      throw new QuotaLifecycleError(
        "operator_intent_invalid",
        "operator subscription upsert supports active or trialing",
      );
    }
    const generatedSubscription = deterministicId(
      "quota_subscription",
      claim.intent.toString(),
      "subscription",
    );
    const item = deterministicId(
      "quota_subscription_item",
      claim.intent.toString(),
      "assignment",
    );
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $intentState = SELECT * FROM ONLY $state;
        IF $intentState = NONE
          OR $intentState.state != "processing"
          OR $intentState.lease_owner != $worker
          OR $intentState.fencing_token != $fencingToken {
          THROW "operator-intent-lease-lost";
        };
        LET $workspaceExists = record::exists($workspace);
        LET $billingExists = record::exists($billingAccount);
        LET $plan = SELECT * FROM ONLY $planRevision;
        IF !$workspaceExists OR !$billingExists OR $plan = NONE {
          THROW "operator-subscription-reference-missing";
        };
        IF $status = "trialing" AND $plan.template_kind != "trial" {
          THROW "operator-subscription-trial-plan-mismatch";
        };
        IF $source = "contract" AND $plan.template_kind != "contract" {
          THROW "operator-subscription-contract-plan-mismatch";
        };
        IF $source = "manual" AND $plan.template_kind = "contract" {
          THROW "operator-subscription-manual-plan-mismatch";
        };
        LET $current = (
          SELECT *
          FROM quota_subscription_item
          WHERE active_workspace = $workspace
          LIMIT 1
        )[0];
        LET $targetSubscription = IF $mode = "plan_rollout" {
          IF $current = NONE {
            THROW "plan-rollout-requires-active-assignment";
          };
          $current.subscription
        } ELSE IF $requestedSubscription != NONE {
          $requestedSubscription
        } ELSE {
          $generatedSubscription
        };
        LET $subscription = SELECT * FROM ONLY $targetSubscription;
        LET $replayed = $current != NONE
          AND $current.causation_id = $intent
          AND $current.subscription = $targetSubscription
          AND $current.plan_revision = $planRevision;
        IF !$replayed {
          IF $subscription = NONE {
            CREATE $targetSubscription CONTENT {
              billing_account: $billingAccount,
              source: $source,
              status: $status,
              revision: 1,
              trial_start: $trialStart,
              trial_end: $trialEnd,
              current_period_start: $currentPeriodStart,
              current_period_end: $currentPeriodEnd,
              paid_through: $paidThrough,
              cancel_at_period_end: false,
              correlation_id: $correlationId,
              causation_id: $intent
            };
          } ELSE IF $mode != "plan_rollout" {
            IF $subscription.billing_account != $billingAccount
              OR $subscription.source != $source {
              THROW "operator-subscription-authority-mismatch";
            };
            UPDATE $targetSubscription SET
              status = $status,
              revision += 1,
              trial_start = $trialStart,
              trial_end = $trialEnd,
              current_period_start = $currentPeriodStart,
              current_period_end = $currentPeriodEnd,
              paid_through = $paidThrough,
              grace_until = NONE,
              cancel_at_period_end = false,
              cancel_at = NONE,
              canceled_at = NONE,
              expires_at = NONE,
              correlation_id = $correlationId,
              causation_id = $intent;
          };
          LET $same = $current != NONE
            AND $current.subscription = $targetSubscription
            AND $current.plan_revision = $planRevision;
          IF !$same {
            IF $current != NONE {
              UPDATE $current.id SET
                status = "ended",
                effective_until = $effectiveAt,
                ended_reason = $mode,
                correlation_id = $correlationId,
                causation_id = $intent;
            };
            CREATE $item CONTENT {
              subscription: $targetSubscription,
              workspace: $workspace,
              plan_revision: $planRevision,
              revision: IF $current = NONE { 1 } ELSE { $current.revision + 1 },
              status: "active",
              effective_from: $effectiveAt,
              correlation_id: $correlationId,
              causation_id: $intent
            };
          };
        };
        UPDATE $state SET affected_workspaces = [$workspace];
        RETURN { workspace: $workspace };
        COMMIT TRANSACTION;
      `,
      {
        workspace,
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        billingAccount,
        planRevision,
        mode,
        requestedSubscription,
        generatedSubscription,
        source,
        status,
        trialStart: optionalDateTime(claim.input.trial_start),
        trialEnd: optionalDateTime(claim.input.trial_end),
        currentPeriodStart: optionalDateTime(
          claim.input.current_period_start,
        ),
        currentPeriodEnd: optionalDateTime(
          claim.input.current_period_end,
        ),
        paidThrough: optionalDateTime(claim.input.paid_through),
        correlationId: claim.correlationId,
        intent: claim.intent.toString(),
        item,
        effectiveAt: claim.effectiveAt,
      },
    );
    const row = lastRecord(result);
    return Object.freeze({
      workspaces: Object.freeze([
        requiredRecordId(row?.workspace, "subscription workspace"),
      ]),
    });
  }

  private async applySubscriptionEnd(
    claim: OperatorIntentClaim,
  ): Promise<OperatorMutationResult> {
    const subscription = requiredRecordId(
      claim.input.subscription,
      "subscription",
    );
    const status = inputString(claim.input, "status");
    if (status !== "paused" && status !== "canceled" && status !== "expired") {
      throw new QuotaLifecycleError(
        "operator_intent_invalid",
        "subscription end status must be paused, canceled, or expired",
      );
    }
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $intentState = SELECT * FROM ONLY $state;
        IF $intentState = NONE
          OR $intentState.state != "processing"
          OR $intentState.lease_owner != $worker
          OR $intentState.fencing_token != $fencingToken {
          THROW "operator-intent-lease-lost";
        };
        LET $subscriptionRow = SELECT * FROM ONLY $subscription;
        IF $subscriptionRow = NONE {
          THROW "operator-subscription-missing";
        };
        LET $activeWorkspaces = SELECT VALUE workspace
          FROM quota_subscription_item
          WHERE subscription = $subscription AND status = "active";
        LET $replayed = $subscriptionRow.causation_id = $intent
          AND array::len($intentState.affected_workspaces) > 0;
        LET $workspaces = IF array::len($activeWorkspaces) > 0 {
          $activeWorkspaces
        } ELSE {
          $intentState.affected_workspaces
        };
        IF !$replayed {
          UPDATE $subscription SET
            status = $status,
            revision += 1,
            paid_through = $effectiveAt,
            cancel_at_period_end = false,
            cancel_at = $effectiveAt,
            canceled_at = IF $status = "canceled" {
              $effectiveAt
            } ELSE {
              canceled_at
            },
            expires_at = IF $status = "expired" {
              $effectiveAt
            } ELSE {
              expires_at
            },
            correlation_id = $correlationId,
            causation_id = $intent;
          UPDATE quota_subscription_item SET
            status = "ended",
            effective_until = $effectiveAt,
            ended_reason = $status,
            correlation_id = $correlationId,
            causation_id = $intent
          WHERE subscription = $subscription AND status = "active";
          UPDATE $state SET affected_workspaces = $workspaces;
        };
        RETURN { workspaces: $workspaces };
        COMMIT TRANSACTION;
      `,
      {
        subscription,
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        status,
        effectiveAt: claim.effectiveAt,
        correlationId: claim.correlationId,
        intent: claim.intent.toString(),
      },
    );
    return Object.freeze({
      workspaces: Object.freeze(recordIds(lastRecord(result)?.workspaces)),
    });
  }

  private async applyOverrideSchedule(
    claim: OperatorIntentClaim,
  ): Promise<OperatorMutationResult> {
    const workspace = inputRecordId(
      claim.input,
      "workspace",
      claim.workspace,
    );
    const patches = claim.input.patches;
    if (!Array.isArray(patches) || patches.length === 0) {
      throw new QuotaLifecycleError(
        "operator_intent_invalid",
        "override requires at least one patch",
      );
    }
    const expiresAt = optionalDateTime(claim.input.expires_at);
    if (
      expiresAt
      && expiresAt.nanoseconds <= claim.effectiveAt.nanoseconds
    ) {
      throw new QuotaLifecycleError(
        "operator_intent_invalid",
        "override expires_at must be after effective_at",
      );
    }
    const revision = deterministicId(
      "quota_override_revision",
      claim.intent.toString(),
    );
    const assignment = deterministicId(
      "workspace_quota_override",
      workspace.toString(),
    );
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $intentState = SELECT * FROM ONLY $state;
        IF $intentState = NONE
          OR $intentState.state != "processing"
          OR $intentState.lease_owner != $worker
          OR $intentState.fencing_token != $fencingToken {
          THROW "operator-intent-lease-lost";
        };
        LET $current = (
          SELECT *
          FROM workspace_quota_override
          WHERE workspace = $workspace
          LIMIT 1
        )[0];
        LET $latestRevision = (
          SELECT VALUE revision
          FROM quota_override_revision
          WHERE workspace = $workspace
          ORDER BY revision DESC
          LIMIT 1
        )[0];
        LET $nextRevision = IF $latestRevision = NONE {
          0
        } ELSE {
          $latestRevision
        };
        IF !record::exists($revision) {
          CREATE $revision CONTENT {
            workspace: $workspace,
            revision: $nextRevision + 1,
            previous_revision: $current.active_revision,
            patches: $patches,
            customer_reason: $customerReason,
            operator_reason: $operatorReason,
            created_by_subject: $actorSubject,
            authorized_capability: $capability,
            effective_at: $effectiveAt,
            expires_at: $expiresAt,
            request_id: $requestId,
            correlation_id: $correlationId,
            causation_id: $intent
          };
        };
        IF $current = NONE {
          CREATE $assignment CONTENT {
            workspace: $workspace,
            active_revision: $revision
          };
        } ELSE {
          UPDATE $current.id SET
            active_revision = $revision,
            scheduled_revision = NONE;
        };
        UPDATE $state SET affected_workspaces = [$workspace];
        COMMIT TRANSACTION;
      `,
      {
        workspace,
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        revision,
        assignment,
        patches: patches as readonly QuotaOverridePatch[],
        customerReason: claim.customerReason,
        operatorReason: claim.operatorReason,
        actorSubject: claim.actorSubject,
        capability: claim.authorizedCapability,
        effectiveAt: claim.effectiveAt,
        expiresAt,
        requestId: claim.requestId,
        correlationId: claim.correlationId,
        intent: claim.intent.toString(),
      },
    );
    return Object.freeze({ workspaces: Object.freeze([workspace]) });
  }

  private async applyOverrideEnd(
    claim: OperatorIntentClaim,
  ): Promise<OperatorMutationResult> {
    const workspace = inputRecordId(
      claim.input,
      "workspace",
      claim.workspace,
    );
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $intentState = SELECT * FROM ONLY $state;
        IF $intentState = NONE
          OR $intentState.state != "processing"
          OR $intentState.lease_owner != $worker
          OR $intentState.fencing_token != $fencingToken {
          THROW "operator-intent-lease-lost";
        };
        UPDATE workspace_quota_override SET
          active_revision = NONE,
          scheduled_revision = NONE
        WHERE workspace = $workspace;
        UPDATE $state SET affected_workspaces = [$workspace];
        COMMIT TRANSACTION;
      `,
      {
        workspace,
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
      },
    );
    return Object.freeze({ workspaces: Object.freeze([workspace]) });
  }

  async settleOperatorIntent(
    claim: OperatorIntentClaim,
    result: EntitlementRefreshResult,
    completedAt: DateTime,
  ): Promise<boolean> {
    const audit = deterministicId(
      "quota_audit_event",
      claim.intent.toString(),
      "processed",
    );
    const queryResult = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $state;
        LET $owns = $current != NONE
          AND $current.state = "processing"
          AND $current.lease_owner = $worker
          AND $current.fencing_token = $fencingToken;
        IF $owns {
          UPDATE $state SET
            state = "processed",
            lease_owner = NONE,
            lease_expires_at = NONE,
            next_attempt_at = NONE,
            entitlement_operation = $entitlementOperation,
            materialization_operation = $materializationOperation,
            last_error_code = NONE,
            last_error_details = NONE,
            processed_at = $completedAt;
          IF !record::exists($audit) {
            CREATE $audit CONTENT {
              event_kind: $eventKind,
              workspace: $workspace,
              billing_account: $billingAccount,
              operator_intent: $intent,
              entitlement_operation: $entitlementOperation,
              materialization_operation: $materializationOperation,
              actor_kind: "operator",
              actor_subject: $actorSubject,
              authorized_capability: $capability,
              reason: $operatorReason,
              request_id: $requestId,
              effective_at: $effectiveAt,
              applied_at: NONE,
              correlation_id: $correlationId,
              causation_id: $intentCausation,
              occurred_at: $completedAt
            };
          };
        };
        RETURN $owns;
        COMMIT TRANSACTION;
      `,
      {
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        entitlementOperation: result.entitlementOperation,
        materializationOperation: result.materializationOperation,
        completedAt,
        audit,
        eventKind: `quota.operator_intent.${claim.kind}.accepted`,
        workspace: claim.workspace,
        billingAccount: claim.billingAccount,
        intent: claim.intent,
        intentCausation: claim.intent.toString(),
        actorSubject: claim.actorSubject,
        capability: claim.authorizedCapability,
        operatorReason: claim.operatorReason,
        requestId: claim.requestId,
        effectiveAt: claim.effectiveAt,
        correlationId: claim.correlationId,
      },
    );
    return lastBoolean(queryResult) === true;
  }

  async failOperatorIntent(
    claim: OperatorIntentClaim,
    failure: {
      errorCode: string;
      errorDetails: ControlPlaneObject;
      nextAttemptAt?: DateTime;
      failedAt: DateTime;
    },
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE $state SET
          state = $failureState,
          lease_owner = NONE,
          lease_expires_at = NONE,
          next_attempt_at = $nextAttemptAt,
          last_error_code = $errorCode,
          last_error_details = $errorDetails,
          processed_at = IF $failureState = "terminal_failed" {
            $failedAt
          } ELSE {
            processed_at
          }
        WHERE state = "processing"
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
        RETURN AFTER;
      `,
      {
        state: claim.state,
        worker: claim.workerId,
        fencingToken: claim.fencingToken,
        failureState:
          failure.nextAttemptAt ? "failed" : "terminal_failed",
        nextAttemptAt: failure.nextAttemptAt,
        errorCode: failure.errorCode,
        errorDetails: failure.errorDetails,
        failedAt: failure.failedAt,
      },
    );
    return firstStatementRow(result) !== undefined;
  }
}
