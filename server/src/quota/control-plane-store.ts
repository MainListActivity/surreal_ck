import {
  NativeQuotaRuleSchema,
  type ControlPlaneObject,
  type QuotaPolicyProjectionRecord,
  type QuotaSweepName,
  type SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import { omitNullishSurrealFields } from "@surreal-ck/shared";
import { DateTime, jsonify, StringRecordId } from "surrealdb";
import { toStringRecordId } from "../db/surreal-values";
import { stableSha256 } from "./canonical";
import type {
  AppliedQuotaState,
  MaterializationLease,
  MaterializationSettlement,
  QuotaMaterializationStore,
} from "./reconciler";
import type {
  MaterializationQueue,
  PersistentSweepStore,
  SweepLease,
} from "./sweeps";

export type QuotaControlPlaneQueryClient = Readonly<{
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statementValue(result: unknown, index = 0): unknown {
  return Array.isArray(result) ? result[index] : undefined;
}

function firstRow(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  return value;
}

function requiredRecord(value: unknown, name: string): UnknownRecord {
  const row = firstRow(value);
  if (!isRecord(row)) throw new TypeError(`missing ${name} control-plane row`);
  return row;
}

function optionalRecord(value: unknown): UnknownRecord | undefined {
  const row = firstRow(value);
  return isRecord(row) ? row : undefined;
}

function requiredId(value: unknown, name: string): StringRecordId {
  const id = toStringRecordId(value);
  if (!id) throw new TypeError(`invalid ${name} record id`);
  return id;
}

function optionalId(value: unknown): StringRecordId | undefined {
  return toStringRecordId(value) ?? undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`invalid ${name}`);
  }
  return value;
}

function integer(value: unknown, fallback = 0): SurrealInteger {
  if (
    typeof value === "bigint"
    || (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  return fallback;
}

function dateTime(value: unknown, name: string): DateTime {
  if (value instanceof DateTime) return value;
  if (value instanceof Date || typeof value === "string") {
    return new DateTime(value);
  }
  throw new TypeError(`invalid ${name} datetime`);
}

function addMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(
    value.nanoseconds + BigInt(Math.round(milliseconds)) * 1_000_000n,
  );
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resultHasRow(result: unknown, statementIndex: number): boolean {
  return optionalRecord(statementValue(result, statementIndex)) !== undefined;
}

function projectionFromRow(row: UnknownRecord): QuotaPolicyProjectionRecord {
  const parsedRules = NativeQuotaRuleSchema.array().parse(
    jsonify(row.rules ?? []),
  );
  const rawLabels = Array.isArray(row.rule_labels) ? row.rule_labels : [];
  return {
    id: requiredId(row.id, "projection"),
    workspace: requiredId(row.workspace, "projection workspace"),
    entitlement: requiredId(row.entitlement, "projection entitlement"),
    revision: integer(row.revision),
    compiler_version: requiredString(
      row.compiler_version,
      "projection compiler version",
    ),
    native_capability: requiredString(
      row.native_capability,
      "projection capability",
    ),
    native_contract_major: integer(row.native_contract_major),
    info_format_version: integer(row.info_format_version),
    rules: parsedRules,
    rule_labels: rawLabels as QuotaPolicyProjectionRecord["rule_labels"],
    canonical_digest: requiredString(
      row.canonical_digest,
      "projection digest",
    ),
    created_at: dateTime(row.created_at, "projection created_at"),
    correlation_id: requiredString(
      row.correlation_id,
      "projection correlation id",
    ),
    causation_id:
      typeof row.causation_id === "string" ? row.causation_id : undefined,
  };
}

function attemptRecordId(
  operation: StringRecordId,
  attemptNumber: SurrealInteger,
): StringRecordId {
  const digest = stableSha256(
    `${operation.toString()}\0${attemptNumber.toString()}`,
  ).slice(0, 28);
  return new StringRecordId(`quota_materialization_attempt:a_${digest}`);
}

function auditRecordId(
  operation: StringRecordId,
  attemptNumber: SurrealInteger,
  eventKind: string,
): StringRecordId {
  const digest = stableSha256(
    `${operation.toString()}\0${attemptNumber.toString()}\0${eventKind}`,
  ).slice(0, 28);
  return new StringRecordId(`quota_audit_event:e_${digest}`);
}

export class SurrealQuotaControlPlaneStore
  implements
    QuotaMaterializationStore,
    MaterializationQueue,
    PersistentSweepStore
{
  constructor(private readonly db: QuotaControlPlaneQueryClient) {}

  async claimNextMaterialization(input: {
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }): Promise<MaterializationLease | undefined> {
    const leaseExpiresAt = addMilliseconds(input.now, input.leaseDurationMs);
    const claim = async () => await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $candidate = (
          SELECT *
          FROM quota_materialization_operation
          WHERE (
            status = "pending"
            AND (next_attempt_at = NONE OR next_attempt_at <= $now)
          ) OR (
            status = "applying"
            AND (lease_expires_at = NONE OR lease_expires_at <= $now)
          )
          ORDER BY created_at ASC
          LIMIT 1
        )[0];
        LET $runtime = IF $candidate != NONE {
          (
            UPDATE workspace_quota_runtime
            SET
              lease_owner = $worker,
              lease_expires_at = $leaseExpiresAt,
              fencing_token += 1,
              sync_state = "applying"
            WHERE workspace = $candidate.workspace
              AND (
                auto_reconcile = true
                OR $candidate.reconcile_mode = "drift_reapply"
              )
              AND (
                lease_owner = NONE
                OR lease_expires_at = NONE
                OR lease_expires_at <= $now
              )
            RETURN AFTER
          )[0]
        } ELSE {
          NONE
        };
        LET $claimed = IF $runtime != NONE {
          (
            UPDATE $candidate.id
            SET
              status = "applying",
              attempt_count += 1,
              lease_owner = $worker,
              lease_expires_at = $leaseExpiresAt,
              fencing_token = $runtime.fencing_token
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
        leaseExpiresAt,
      },
    );
    let claimResult: unknown;
    try {
      claimResult = await claim();
    } catch {
      claimResult = await claim();
    }
    const claimed = optionalRecord(statementValue(claimResult, 4));
    if (!claimed) return undefined;
    return this.loadMaterializationLease(claimed, input.workerId);
  }

  private async loadMaterializationLease(
    claimed: UnknownRecord,
    workerId: string,
  ): Promise<MaterializationLease> {
    const operation = requiredId(claimed.id, "materialization operation");
    const workspace = requiredId(claimed.workspace, "operation workspace");
    const projectionId = requiredId(claimed.projection, "operation projection");
    const contextResult = await this.db.query(
      `
        SELECT * FROM ONLY $workspace;
        SELECT * FROM ONLY $projection;
        SELECT * FROM ONLY workspace_quota_runtime WHERE workspace = $workspace;
        SELECT count() AS count
        FROM quota_materialization_attempt
        WHERE operation = $operation
          AND outcome INSIDE ["succeeded", "commit_unknown"]
        GROUP ALL;
      `,
      {
        operation,
        workspace,
        projection: projectionId,
      },
    );
    const workspaceRow = requiredRecord(
      statementValue(contextResult, 0),
      "workspace",
    );
    const projection = projectionFromRow(
      requiredRecord(statementValue(contextResult, 1), "projection"),
    );
    const runtime = requiredRecord(
      statementValue(contextResult, 2),
      "workspace quota runtime",
    );
    const attemptCountRow = optionalRecord(statementValue(contextResult, 3));
    const appliedProjectionId = optionalId(
      workspaceRow.applied_quota_projection,
    );
    let applied: AppliedQuotaState | undefined;
    if (appliedProjectionId) {
      const appliedResult = await this.db.query(
        "SELECT * FROM ONLY $projection;",
        { projection: appliedProjectionId },
      );
      const appliedRow = requiredRecord(
        statementValue(appliedResult, 0),
        "applied projection",
      );
      applied = Object.freeze({
        entitlement: requiredId(
          workspaceRow.applied_entitlement,
          "applied entitlement",
        ),
        projection: appliedProjectionId,
        canonicalDigest: requiredString(
          appliedRow.canonical_digest,
          "applied projection digest",
        ),
        nativeGeneration: runtime.native_observed_generation === undefined
          ? undefined
          : integer(runtime.native_observed_generation),
      });
    }
    const workspaceStatus = workspaceRow.status;
    if (
      workspaceStatus !== "active"
      && workspaceStatus !== "provisioning"
      && workspaceStatus !== "provisioning_error"
    ) {
      throw new TypeError("workspace cannot be materialized in its current status");
    }
    const desiredEntitlement = requiredId(
      workspaceRow.desired_entitlement,
      "desired entitlement",
    );
    const desiredProjection = requiredId(
      workspaceRow.desired_quota_projection,
      "desired projection",
    );
    return Object.freeze({
      operation,
      workspace,
      database: requiredString(workspaceRow.db_name, "workspace database"),
      entitlement: requiredId(claimed.entitlement, "operation entitlement"),
      projection,
      desiredEntitlement,
      desiredProjection,
      applied,
      workspaceStatus,
      autoReconcile: bool(runtime.auto_reconcile, true),
      allowExternalDriftOverwrite:
        claimed.reconcile_mode === "drift_reapply",
      executionStarted: Number(attemptCountRow?.count ?? 0) > 0,
      workerId,
      fencingToken: integer(claimed.fencing_token),
      attemptNumber: integer(claimed.attempt_count),
      startedAt: dateTime(inputDate(claimed, "updated_at"), "attempt start"),
      leaseExpiresAt: dateTime(
        claimed.lease_expires_at,
        "operation lease_expires_at",
      ),
      correlationId: requiredString(
        claimed.correlation_id,
        "operation correlation id",
      ),
    });
  }

  async renewMaterializationLease(
    lease: MaterializationLease,
    now: DateTime,
    leaseDurationMs: number,
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE workspace_quota_runtime
        SET lease_expires_at = $leaseExpiresAt
        WHERE workspace = $workspace
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
          AND lease_expires_at > $now
        RETURN AFTER;
        UPDATE $operation
        SET lease_expires_at = $leaseExpiresAt
        WHERE status = "applying"
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
        RETURN AFTER;
      `,
      {
        operation: lease.operation,
        workspace: lease.workspace,
        worker: lease.workerId,
        fencingToken: lease.fencingToken,
        now,
        leaseExpiresAt: addMilliseconds(now, leaseDurationMs),
      },
    );
    return resultHasRow(result, 0) && resultHasRow(result, 1);
  }

  async settleMaterialization(
    lease: MaterializationLease,
    settlement: MaterializationSettlement,
  ): Promise<"committed" | "lease_lost"> {
    const attemptId = attemptRecordId(
      lease.operation,
      lease.attemptNumber,
    );
    const completedAt = settlement.completedAt;
    const durationMs = Number(
      (completedAt.nanoseconds - lease.startedAt.nanoseconds) / 1_000_000n,
    );
    const attemptBase = omitNullishSurrealFields({
      operation: lease.operation,
      attempt_number: lease.attemptNumber,
      fencing_token: lease.fencingToken,
      worker_id: lease.workerId,
      outcome: settlement.outcome,
      observed_before_generation: settlement.observedBeforeGeneration,
      observed_before_digest: settlement.observedBeforeDigest,
      native_operation_id: settlement.nativeOperationId,
      observed_after_generation: settlement.observedAfterGeneration,
      observed_after_digest: settlement.observedAfterDigest,
      ledger_state: settlement.ledgerState,
      usage_trusted: settlement.usageTrusted,
      error_code: settlement.errorCode,
      error_retryable: settlement.errorRetryable,
      error_details: settlement.errorDetails,
      started_at: lease.startedAt,
      completed_at: completedAt,
      duration_ms: Math.max(0, durationMs),
      correlation_id: lease.correlationId,
      causation_id: lease.operation.toString(),
    });
    const leaseLostAttempt = {
      ...attemptBase,
      outcome: "lease_lost",
      error_code: "lease_lost",
      error_retryable: true,
      error_details: {
        attempted_outcome: settlement.outcome,
        fencing_token: lease.fencingToken,
      },
    };
    const operationPatch = { ...this.operationPatch(settlement) };
    if (
      (settlement.kind === "retry" || settlement.kind === "terminal")
      && BigInt(lease.attemptNumber) > 1n
    ) {
      delete operationPatch.first_failed_at;
    }
    const runtimePatch = this.runtimePatch(settlement);
    const workspacePatch = settlement.kind === "succeeded"
      ? {
          applied_entitlement: lease.entitlement,
          applied_quota_projection: lease.projection.id,
        }
      : undefined;
    const securityEventKind = settlement.kind === "terminal"
        && settlement.syncState === "external_drift"
      ? "quota.external_drift.detected"
      : settlement.kind === "succeeded"
        && lease.workspaceStatus === "active"
        && settlement.observedBeforeDigest === undefined
        && lease.applied !== undefined
      ? "quota.policy_missing.restored"
      : undefined;
    const auditId = securityEventKind
      ? auditRecordId(lease.operation, lease.attemptNumber, securityEventKind)
      : undefined;
    const auditContent = securityEventKind
      ? omitNullishSurrealFields({
          event_kind: securityEventKind,
          workspace: lease.workspace,
          materialization_operation: lease.operation,
          materialization_attempt: attemptId,
          actor_kind: "system",
          before_reference: lease.applied?.projection.toString(),
          after_reference: lease.projection.id.toString(),
          before_digest: settlement.observedBeforeDigest,
          after_digest: settlement.observedAfterDigest,
          error_code: settlement.errorCode,
          error_details: settlement.errorDetails,
          applied_at:
            settlement.kind === "succeeded" ? settlement.completedAt : undefined,
          correlation_id: lease.correlationId,
          causation_id: lease.operation.toString(),
          occurred_at: settlement.completedAt,
        })
      : undefined;
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $operation;
        LET $runtime = (
          SELECT *
          FROM ONLY workspace_quota_runtime
          WHERE workspace = $workspace
        );
        LET $owns = $current != NONE
          AND $runtime != NONE
          AND $current.status = "applying"
          AND $current.lease_owner = $worker
          AND $current.fencing_token = $fencingToken
          AND $runtime.lease_owner = $worker
          AND $runtime.fencing_token = $fencingToken;
        IF !record::exists($attempt) {
          IF $owns {
            CREATE $attempt CONTENT $attemptContent;
          } ELSE {
            CREATE $attempt CONTENT $leaseLostAttemptContent;
          };
        };
        IF $owns {
          UPDATE $operation MERGE $operationPatch;
          IF $workspacePatch != NONE {
            UPDATE $workspace MERGE $workspacePatch;
          };
          UPDATE workspace_quota_runtime
          MERGE $runtimePatch
          WHERE workspace = $workspace
            AND lease_owner = $worker
            AND fencing_token = $fencingToken;
          IF $succeeded {
            LET $latest = (
              SELECT VALUE
                desired_entitlement = $entitlement
                AND desired_quota_projection = $projection
              FROM ONLY $workspace
            );
            UPDATE workspace_quota_runtime
            SET sync_state = IF $latest { "in_sync" } ELSE { "pending" }
            WHERE workspace = $workspace
              AND fencing_token = $fencingToken;
          };
          IF $audit != NONE AND !record::exists($audit) {
            CREATE $audit CONTENT $auditContent;
          };
        };
        RETURN $owns;
        COMMIT TRANSACTION;
      `,
      {
        operation: lease.operation,
        workspace: lease.workspace,
        entitlement: lease.entitlement,
        projection: lease.projection.id,
        worker: lease.workerId,
        fencingToken: lease.fencingToken,
        attempt: attemptId,
        attemptContent: attemptBase,
        leaseLostAttemptContent: leaseLostAttempt,
        operationPatch,
        workspacePatch,
        runtimePatch,
        succeeded: settlement.kind === "succeeded",
        audit: auditId,
        auditContent,
      },
    );
    return statementValue(result, 6) === true ? "committed" : "lease_lost";
  }

  private operationPatch(
    settlement: MaterializationSettlement,
  ): ControlPlaneObject {
    const base = {
      lease_owner: undefined,
      lease_expires_at: undefined,
      completed_at: settlement.kind === "retry" && !settlement.exhausted
        ? undefined
        : settlement.completedAt,
      observed_before_generation: settlement.observedBeforeGeneration,
      observed_before_digest: settlement.observedBeforeDigest,
      native_operation_id: settlement.nativeOperationId,
      applied_native_generation: settlement.observedAfterGeneration,
      readback_digest: settlement.observedAfterDigest,
    };
    if (settlement.kind === "succeeded") {
      return {
        ...base,
        status: "succeeded",
        applied_at: settlement.completedAt,
        next_attempt_at: undefined,
        last_error_code: undefined,
        last_error_retryable: undefined,
        last_error_details: undefined,
      };
    }
    if (settlement.kind === "retry") {
      return {
        ...base,
        status: settlement.exhausted ? "failed" : "pending",
        next_attempt_at: settlement.exhausted
          ? undefined
          : settlement.nextAttemptAt,
        first_failed_at: settlement.completedAt,
        last_failed_at: settlement.completedAt,
        last_error_code: settlement.errorCode,
        last_error_retryable: settlement.errorRetryable,
        last_error_details: settlement.errorDetails,
      };
    }
    if (settlement.kind === "terminal") {
      return {
        ...base,
        status: "failed",
        next_attempt_at: undefined,
        first_failed_at: settlement.completedAt,
        last_failed_at: settlement.completedAt,
        last_error_code: settlement.errorCode,
        last_error_retryable: settlement.errorRetryable,
        last_error_details: settlement.errorDetails,
      };
    }
    if (settlement.kind === "superseded") {
      return {
        ...base,
        status: "superseded",
        superseded_by: settlement.supersededBy,
        next_attempt_at: undefined,
      };
    }
    return base;
  }

  private runtimePatch(
    settlement: MaterializationSettlement,
  ): ControlPlaneObject {
    const observedAt = settlement.completedAt;
    const base = {
      lease_owner: undefined,
      lease_expires_at: undefined,
      native_observed_at: observedAt,
      native_observed_generation: settlement.observedAfterGeneration,
      native_observed_digest: settlement.observedAfterDigest,
      ledger_state: settlement.ledgerState,
      usage_trusted: settlement.usageTrusted ?? false,
    };
    if (settlement.kind === "succeeded") {
      return {
        ...base,
        last_sync_error_code: undefined,
        last_sync_error_retryable: undefined,
        last_sync_error_details: undefined,
      };
    }
    if (settlement.kind === "superseded") {
      return { ...base, sync_state: "pending" };
    }
    if (settlement.kind === "terminal") {
      return {
        ...base,
        sync_state: settlement.syncState,
        last_sync_error_code: settlement.errorCode,
        last_sync_error_retryable: settlement.errorRetryable,
        last_sync_error_details: settlement.errorDetails,
      };
    }
    if (settlement.kind === "retry") {
      return {
        ...base,
        sync_state: settlement.exhausted ? "error" : "pending",
        last_sync_error_code: settlement.errorCode,
        last_sync_error_retryable: settlement.errorRetryable,
        last_sync_error_details: settlement.errorDetails,
      };
    }
    return {
      ...base,
      sync_state: "pending",
      last_sync_error_code: "lease_lost",
      last_sync_error_retryable: true,
    };
  }

  async claimSweep(input: {
    name: QuotaSweepName;
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }): Promise<SweepLease | undefined> {
    const leaseExpiresAt = addMilliseconds(input.now, input.leaseDurationMs);
    const claim = async () => await this.db.query(
      `
        BEGIN TRANSACTION;
        INSERT INTO quota_sweep_cursor {
          sweep_name: $name,
          epoch: 0,
          fencing_token: 0,
          attempt_count: 0
        }
        ON DUPLICATE KEY UPDATE sweep_name = $input.sweep_name;
        LET $claimed = (
          UPDATE quota_sweep_cursor
          SET
            lease_owner = $worker,
            lease_expires_at = $leaseExpiresAt,
            fencing_token += 1,
            attempt_count += 1,
            last_started_at = $now
          WHERE sweep_name = $name
            AND (next_attempt_at = NONE OR next_attempt_at <= $now)
            AND (
              lease_owner = NONE
              OR lease_expires_at = NONE
              OR lease_expires_at <= $now
            )
          RETURN AFTER
        )[0];
        RETURN $claimed;
        COMMIT TRANSACTION;
      `,
      {
        name: input.name,
        worker: input.workerId,
        now: input.now,
        leaseExpiresAt,
      },
    );
    let result: unknown;
    try {
      result = await claim();
    } catch {
      result = await claim();
    }
    const row = optionalRecord(statementValue(result, 3));
    if (!row) return undefined;
    return Object.freeze({
      name: input.name,
      workerId: input.workerId,
      fencingToken: integer(row.fencing_token),
      cursor: typeof row.cursor === "string" ? row.cursor : undefined,
      epoch: integer(row.epoch),
      attemptNumber: integer(row.attempt_count),
      startedAt: dateTime(row.last_started_at, "sweep last_started_at"),
      leaseExpiresAt: dateTime(
        row.lease_expires_at,
        "sweep lease_expires_at",
      ),
    });
  }

  async checkpointSweep(
    lease: SweepLease,
    checkpoint: {
      cursor?: string;
      completed: boolean;
      processed: number;
      failed: number;
      completedAt: DateTime;
    },
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE quota_sweep_cursor
        SET
          cursor = $cursor,
          epoch = $epoch,
          lease_owner = NONE,
          lease_expires_at = NONE,
          attempt_count = 0,
          next_attempt_at = NONE,
          last_error_code = NONE,
          last_error_retryable = NONE,
          last_error_details = NONE,
          last_completed_at = $completedAt
        WHERE sweep_name = $name
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
        RETURN AFTER;
      `,
      {
        name: lease.name,
        worker: lease.workerId,
        fencingToken: lease.fencingToken,
        cursor: checkpoint.completed ? undefined : checkpoint.cursor,
        epoch: checkpoint.completed
          ? BigInt(lease.epoch) + 1n
          : lease.epoch,
        completedAt: checkpoint.completedAt,
      },
    );
    return resultHasRow(result, 0);
  }

  async failSweep(
    lease: SweepLease,
    failure: {
      errorCode: string;
      errorRetryable: boolean;
      errorDetails: ControlPlaneObject;
      nextAttemptAt: DateTime;
      failedAt: DateTime;
    },
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE quota_sweep_cursor
        SET
          lease_owner = NONE,
          lease_expires_at = NONE,
          next_attempt_at = $nextAttemptAt,
          last_error_code = $errorCode,
          last_error_retryable = $errorRetryable,
          last_error_details = $errorDetails
        WHERE sweep_name = $name
          AND lease_owner = $worker
          AND fencing_token = $fencingToken
        RETURN AFTER;
      `,
      {
        name: lease.name,
        worker: lease.workerId,
        fencingToken: lease.fencingToken,
        nextAttemptAt: failure.nextAttemptAt,
        errorCode: failure.errorCode,
        errorRetryable: failure.errorRetryable,
        errorDetails: failure.errorDetails,
      },
    );
    return resultHasRow(result, 0);
  }
}

function inputDate(
  record: UnknownRecord,
  field: string,
): unknown {
  return record[field] ?? DateTime.now();
}
