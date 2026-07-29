import {
  NativeQuotaRuleSchema,
  type ProductQuotaRule,
  type QuotaMigrationAssignmentManifest,
  type QuotaMigrationCohort,
  type QuotaMigrationInventory,
  type QuotaMigrationMaintenanceEvidence,
  type QuotaMigrationSignal,
  type SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId, jsonify } from "surrealdb";
import { toStringRecordId } from "../db/surreal-values";
import { stableSha256 } from "../quota/canonical";
import {
  cohortObservationHours,
  cohortOrdinal,
  isBlockingMigrationSignal,
  migrationChecksum,
  QuotaMigrationError,
} from "./model";

export type QuotaMigrationSystemQueryClient = Readonly<{
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statements(result: unknown): unknown[] {
  const value = jsonify(result);
  return Array.isArray(value) ? value : [];
}

function statementRows(result: unknown, index = 0): UnknownRecord[] {
  const value = statements(result)[index];
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function statementValues(result: unknown, index = 0): unknown[] {
  const value = statements(result)[index];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function nestedRecords(value: unknown): UnknownRecord[] {
  if (isRecord(value)) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(nestedRecords);
}

function lastRecord(result: unknown): UnknownRecord | undefined {
  return nestedRecords(jsonify(result)).at(-1);
}

function requiredRecordId(value: unknown, field: string): StringRecordId {
  const id = toStringRecordId(value);
  if (!id) {
    throw new QuotaMigrationError(
      "migration_store_contract_invalid",
      `invalid ${field} record id`,
    );
  }
  return id;
}

function optionalRecordId(value: unknown): StringRecordId | undefined {
  return toStringRecordId(value) ?? undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new QuotaMigrationError(
      "migration_store_contract_invalid",
      `invalid ${field}`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function integer(value: unknown): SurrealInteger {
  if (
    typeof value === "bigint"
    || (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  throw new QuotaMigrationError(
    "migration_store_contract_invalid",
    "invalid migration integer",
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

export type QuotaMigrationWorkspace = Readonly<{
  id: StringRecordId;
  slug: string;
  database: string;
  status: "active" | "provisioning";
}>;

export type QuotaMigrationPlanRevision = Readonly<{
  id: StringRecordId;
  templateKind: "commercial" | "contract";
  rules: readonly ProductQuotaRule[];
}>;

export type QuotaMigrationManifestContext = Readonly<{
  workspaces: readonly QuotaMigrationWorkspace[];
  plans: ReadonlyMap<string, QuotaMigrationPlanRevision>;
  billingAccounts: ReadonlySet<string>;
  approverAuthorized: boolean;
}>;

export type QuotaMigrationRun = Readonly<{
  id: StringRecordId;
  runKey: string;
  inventoryChecksum: string;
  manifestChecksum?: string;
  state: string;
  publicReopenReady: boolean;
  currentCohort?: QuotaMigrationCohort;
  pausedFromState?: string;
  cleanupNotBefore?: DateTime;
  allNativeVerifiedAt?: DateTime;
  fullAuditCleanAt?: DateTime;
  productReleaseStableSince?: DateTime;
  preNativeCompatibilityBlockedAt?: DateTime;
  maintenanceEvidence?: QuotaMigrationMaintenanceEvidence;
}>;

export type QuotaMigrationWorkspaceOperation = Readonly<{
  id: StringRecordId;
  run: StringRecordId;
  workspace: StringRecordId;
  workspaceStatus: "active" | "provisioning";
  slug: string;
  database: string;
  state: string;
  cohort?: QuotaMigrationCohort;
  inventoryEventTargets: readonly string[];
  assignment?: StringRecordId;
  fencingToken: SurrealInteger;
  leaseOwner?: string;
  observedGeneration?: SurrealInteger;
  observedDigest?: string;
}>;

export type QuotaMigrationWorkspaceLease =
  QuotaMigrationWorkspaceOperation & Readonly<{
    workerId: string;
    fencingToken: SurrealInteger;
  }>;

function dateTime(value: unknown): DateTime | undefined {
  if (value instanceof DateTime) return value;
  if (value instanceof Date) return new DateTime(value.toISOString());
  if (typeof value === "string" && value.length > 0) {
    return new DateTime(value);
  }
  return undefined;
}

function runFromRow(row: UnknownRecord): QuotaMigrationRun {
  const currentCohort = optionalString(row.current_cohort);
  return Object.freeze({
    id: requiredRecordId(row.id, "migration run"),
    runKey: requiredString(row.run_key, "migration run key"),
    inventoryChecksum: requiredString(
      row.inventory_checksum,
      "migration inventory checksum",
    ),
    manifestChecksum: optionalString(row.manifest_checksum),
    state: requiredString(row.state, "migration run state"),
    publicReopenReady: row.public_reopen_ready === true,
    currentCohort: currentCohort as QuotaMigrationCohort | undefined,
    pausedFromState: optionalString(row.paused_from_state),
    cleanupNotBefore: dateTime(row.cleanup_not_before),
    allNativeVerifiedAt: dateTime(row.all_native_verified_at),
    fullAuditCleanAt: dateTime(row.full_audit_clean_at),
    productReleaseStableSince: dateTime(row.product_release_stable_since),
    preNativeCompatibilityBlockedAt: dateTime(
      row.pre_native_compatibility_blocked_at,
    ),
    maintenanceEvidence: isRecord(row.maintenance_evidence)
      ? row.maintenance_evidence as QuotaMigrationMaintenanceEvidence
      : undefined,
  });
}

function operationFromRow(
  row: UnknownRecord,
): QuotaMigrationWorkspaceOperation {
  const status = requiredString(row.workspace_status, "workspace status");
  if (status !== "active" && status !== "provisioning") {
    throw new QuotaMigrationError(
      "migration_store_contract_invalid",
      "invalid workspace migration status",
    );
  }
  return Object.freeze({
    id: requiredRecordId(row.id, "workspace migration operation"),
    run: requiredRecordId(row.run, "migration run"),
    workspace: requiredRecordId(row.workspace, "migration workspace"),
    workspaceStatus: status,
    slug: requiredString(row.workspace_slug, "workspace slug"),
    database: requiredString(row.db_name, "workspace database"),
    state: requiredString(row.state, "workspace migration state"),
    cohort: optionalString(row.cohort) as QuotaMigrationCohort | undefined,
    inventoryEventTargets: Array.isArray(row.inventory_event_targets)
      ? row.inventory_event_targets.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    assignment: optionalRecordId(row.assignment),
    fencingToken: integer(row.fencing_token),
    leaseOwner: optionalString(row.lease_owner),
    observedGeneration:
      row.observed_native_generation === undefined
        || row.observed_native_generation === null
        ? undefined
        : integer(row.observed_native_generation),
    observedDigest: optionalString(row.observed_native_digest),
  });
}

export class SurrealQuotaMigrationStore {
  constructor(private readonly db: QuotaMigrationSystemQueryClient) {}

  async listWorkspaces(): Promise<readonly QuotaMigrationWorkspace[]> {
    const result = await this.db.query(
      `
        SELECT id, slug, db_name, status
        FROM workspace
        WHERE status INSIDE ["active", "provisioning"]
        ORDER BY id;
      `,
    );
    return Object.freeze(statementRows(result).map((row) => {
      const status = requiredString(row.status, "workspace status");
      if (status !== "active" && status !== "provisioning") {
        throw new QuotaMigrationError(
          "migration_store_contract_invalid",
          "invalid inventory workspace status",
        );
      }
      return Object.freeze({
        id: requiredRecordId(row.id, "workspace"),
        slug: requiredString(row.slug, "workspace slug"),
        database: requiredString(row.db_name, "workspace database"),
        status,
      });
    }));
  }

  async manifestContext(
    manifest: QuotaMigrationAssignmentManifest,
  ): Promise<QuotaMigrationManifestContext> {
    const planIds = [...new Set(
      manifest.assignments.map((assignment) => assignment.plan_revision_id),
    )].map((id) => new StringRecordId(id));
    const billingIds = [...new Set(
      manifest.assignments.map((assignment) => assignment.billing_account_id),
    )].map((id) => new StringRecordId(id));
    const result = await this.db.query(
      `
        SELECT id, slug, db_name, status
        FROM workspace
        WHERE status INSIDE ["active", "provisioning"]
        ORDER BY id;
        SELECT id, template_kind, rules
        FROM quota_plan_revision
        WHERE id IN $planRevisions;
        SELECT VALUE id
        FROM billing_account
        WHERE id IN $billingAccounts AND status = "active";
        RETURN array::len(
          SELECT id
          FROM platform_operator
          WHERE subject = $approver AND status = "active"
            AND id IN (
              SELECT VALUE operator
              FROM platform_operator_capability
              WHERE capability = "subscription.manage"
                AND status = "active"
            )
        ) = 1;
      `,
      {
        planRevisions: planIds,
        billingAccounts: billingIds,
        approver: manifest.approved_by_subject,
      },
    );
    const workspaces = statementRows(result, 0).map((row) => {
      const status = requiredString(row.status, "workspace status");
      if (status !== "active" && status !== "provisioning") {
        throw new QuotaMigrationError(
          "migration_store_contract_invalid",
          "invalid manifest workspace status",
        );
      }
      return Object.freeze({
        id: requiredRecordId(row.id, "workspace"),
        slug: requiredString(row.slug, "workspace slug"),
        database: requiredString(row.db_name, "workspace database"),
        status,
      });
    });
    const plans = new Map<string, QuotaMigrationPlanRevision>();
    for (const row of statementRows(result, 1)) {
      const templateKind = requiredString(
        row.template_kind,
        "plan template kind",
      );
      if (templateKind !== "commercial" && templateKind !== "contract") {
        continue;
      }
      const id = requiredRecordId(row.id, "plan revision");
      plans.set(id.toString(), Object.freeze({
        id,
        templateKind,
        rules: Array.isArray(row.rules)
          ? row.rules as readonly ProductQuotaRule[]
          : [],
      }));
    }
    const billingAccounts = new Set(
      statementValues(result, 2)
        .map(recordStringFromValue)
        .filter((id): id is string => id !== undefined),
    );
    const approverAuthorized = statementValues(result, 3)[0] === true;
    return Object.freeze({
      workspaces: Object.freeze(workspaces),
      plans,
      billingAccounts,
      approverAuthorized,
    });
  }

  async loadPlanRevision(
    id: string,
  ): Promise<QuotaMigrationPlanRevision | undefined> {
    const result = await this.db.query(
      "SELECT id, template_kind, rules FROM ONLY $plan;",
      { plan: new StringRecordId(id) },
    );
    const row = statementRows(result)[0];
    if (!row) return undefined;
    const templateKind = requiredString(row.template_kind, "template kind");
    if (templateKind !== "commercial" && templateKind !== "contract") {
      return undefined;
    }
    return Object.freeze({
      id: requiredRecordId(row.id, "plan revision"),
      templateKind,
      rules: Array.isArray(row.rules)
        ? row.rules as readonly ProductQuotaRule[]
        : [],
    });
  }

  async persistInventory(
    inventory: QuotaMigrationInventory,
  ): Promise<QuotaMigrationRun> {
    const run = deterministicId("quota_migration_run", inventory.run_id);
    const entries = inventory.workspaces.map((workspace) => {
      const inventoryId = deterministicId(
        "quota_migration_inventory",
        inventory.run_id,
        workspace.workspace_id,
      );
      const operationId = deterministicId(
        "quota_migration_workspace_operation",
        inventory.run_id,
        workspace.workspace_id,
      );
      return {
        inventory_id: inventoryId,
        operation_id: operationId,
        workspace: new StringRecordId(workspace.workspace_id),
        workspace_slug: workspace.workspace_slug,
        db_name: workspace.database,
        workspace_status: workspace.workspace_status,
        snapshot: workspace,
        checksum: workspace.checksum,
        blocking_anomalies: workspace.anomalies
          .filter((anomaly) => anomaly.severity === "blocker")
          .map((anomaly) => anomaly.code),
        event_targets: workspace.legacy?.event_targets
          .map((target) => target.table) ?? [],
      };
    });
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $existing = SELECT * FROM ONLY $run;
        IF $existing != NONE
          AND $existing.inventory_checksum != $inventoryChecksum {
          THROW "migration-inventory-idempotency-conflict";
        };
        IF $existing = NONE {
          CREATE $run CONTENT {
            run_key: $runKey,
            inventory_checksum: $inventoryChecksum,
            state: "inventory_ready",
            public_reopen_ready: false
          };
        };
        FOR $entry IN $entries {
          IF !record::exists($entry.inventory_id) {
            CREATE $entry.inventory_id CONTENT {
              run: $run,
              workspace: $entry.workspace,
              workspace_slug: $entry.workspace_slug,
              db_name: $entry.db_name,
              workspace_status: $entry.workspace_status,
              snapshot: $entry.snapshot,
              checksum: $entry.checksum,
              blocking_anomalies: $entry.blocking_anomalies
            };
          };
          IF !record::exists($entry.operation_id) {
            CREATE $entry.operation_id CONTENT {
              run: $run,
              workspace: $entry.workspace,
              inventory: $entry.inventory_id,
              state: "inventoried",
              attempt_count: 0,
              fencing_token: 0,
              inventory_event_targets: $entry.event_targets
            };
          };
        };
        RETURN SELECT * FROM ONLY $run;
        COMMIT TRANSACTION;
      `,
      {
        run,
        runKey: inventory.run_id,
        inventoryChecksum: inventory.checksum,
        entries,
      },
    );
    const row = lastRecord(result);
    if (!row) {
      throw new QuotaMigrationError(
        "migration_inventory_persist_failed",
        "inventory transaction returned no run",
      );
    }
    return runFromRow(row);
  }

  async findRun(runKey: string): Promise<QuotaMigrationRun | undefined> {
    const result = await this.db.query(
      "SELECT * FROM quota_migration_run WHERE run_key = $runKey LIMIT 1;",
      { runKey },
    );
    const row = statementRows(result)[0];
    return row ? runFromRow(row) : undefined;
  }

  async inventoryBlockers(run: StringRecordId): Promise<readonly string[]> {
    const result = await this.db.query(
      `
        SELECT VALUE blocking_anomalies
        FROM quota_migration_inventory
        WHERE run = $run AND array::len(blocking_anomalies) > 0;
      `,
      { run },
    );
    const values = statementValues(result).flatMap((value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
    );
    return Object.freeze(values);
  }

  async persistAssignments(
    run: QuotaMigrationRun,
    manifest: QuotaMigrationAssignmentManifest,
    cohorts: ReadonlyMap<string, QuotaMigrationCohort>,
  ): Promise<void> {
    const entries = manifest.assignments.map((assignment) => ({
      id: deterministicId(
        "quota_migration_assignment",
        run.runKey,
        assignment.workspace_id,
      ),
      operation: deterministicId(
        "quota_migration_workspace_operation",
        run.runKey,
        assignment.workspace_id,
      ),
      workspace: new StringRecordId(assignment.workspace_id),
      workspace_slug: assignment.workspace_slug,
      db_name: assignment.database,
      billing_account: new StringRecordId(assignment.billing_account_id),
      plan_revision: new StringRecordId(assignment.plan_revision_id),
      source: assignment.source,
      effective_at: new DateTime(assignment.effective_at),
      rollout_class: assignment.rollout_class,
      cohort: cohorts.get(assignment.workspace_id),
      evidence_reference: assignment.evidence_reference,
      assignment_checksum: migrationChecksum(assignment),
    }));
    const cohortEntries = [
      "synthetic_internal",
      "one_percent",
      "ten_percent",
      "fifty_percent",
      "remainder",
    ].map((cohort) => ({
      id: deterministicId(
        "quota_migration_cohort",
        run.runKey,
        cohort,
      ),
      cohort,
      ordinal: cohortOrdinal(cohort as QuotaMigrationCohort),
      required_observation_hours: cohortObservationHours(
        cohort as QuotaMigrationCohort,
      ),
    }));
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $run;
        IF $current = NONE
          OR $current.inventory_checksum != $inventoryChecksum {
          THROW "migration-run-inventory-mismatch";
        };
        IF $current.manifest_checksum != NONE
          AND $current.manifest_checksum != $manifestChecksum {
          THROW "migration-manifest-idempotency-conflict";
        };
        UPDATE $run SET state = "manifest_importing";
        FOR $entry IN $entries {
          LET $existing = SELECT * FROM ONLY $entry.id;
          IF $existing != NONE
            AND $existing.assignment_checksum != $entry.assignment_checksum {
            THROW "migration-assignment-idempotency-conflict";
          };
          IF $existing = NONE {
            CREATE $entry.id CONTENT {
              run: $run,
              workspace: $entry.workspace,
              workspace_slug: $entry.workspace_slug,
              db_name: $entry.db_name,
              billing_account: $entry.billing_account,
              plan_revision: $entry.plan_revision,
              source: $entry.source,
              effective_at: $entry.effective_at,
              rollout_class: $entry.rollout_class,
              cohort: $entry.cohort,
              evidence_reference: $entry.evidence_reference,
              approved_by_subject: $approvedBy,
              approved_at: $approvedAt,
              assignment_checksum: $entry.assignment_checksum
            };
          };
          UPDATE $entry.operation SET
            assignment = $entry.id,
            cohort = $entry.cohort,
            state = "assignment_approved",
            last_error_code = NONE,
            last_error_details = NONE;
        };
        FOR $cohort IN $cohorts {
          IF !record::exists($cohort.id) {
            CREATE $cohort.id CONTENT {
              run: $run,
              cohort: $cohort.cohort,
              ordinal: $cohort.ordinal,
              state: "pending",
              required_observation_hours: $cohort.required_observation_hours
            };
          };
        };
        UPDATE $run SET
          manifest_checksum = $manifestChecksum,
          state = "assignments_ready";
        COMMIT TRANSACTION;
      `,
      {
        run: run.id,
        inventoryChecksum: manifest.inventory_checksum,
        manifestChecksum: manifest.checksum,
        entries,
        cohorts: cohortEntries,
        approvedBy: manifest.approved_by_subject,
        approvedAt: new DateTime(manifest.approved_at),
      },
    );
  }

  async applyAssignmentAuthority(
    run: QuotaMigrationRun,
    manifest: QuotaMigrationAssignmentManifest,
    workspaceId: string,
  ): Promise<void> {
    const assignment = manifest.assignments.find(
      (entry) => entry.workspace_id === workspaceId,
    );
    if (!assignment) {
      throw new QuotaMigrationError(
        "migration_assignment_missing",
        "workspace assignment is missing from manifest",
      );
    }
    const assignmentId = deterministicId(
      "quota_migration_assignment",
      run.runKey,
      workspaceId,
    );
    const subscription = deterministicId(
      "quota_subscription",
      run.runKey,
      workspaceId,
      "subscription",
    );
    const item = deterministicId(
      "quota_subscription_item",
      run.runKey,
      workspaceId,
      "assignment",
    );
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $assignment = SELECT * FROM ONLY $assignment;
        IF $assignment = NONE {
          THROW "migration-assignment-missing";
        };
        LET $current = (
          SELECT *
          FROM quota_subscription_item
          WHERE active_workspace = $workspace
          LIMIT 1
        )[0];
        LET $replayed = $current != NONE AND $current.id = $item;
        IF !$replayed {
          IF !record::exists($subscription) {
            CREATE $subscription CONTENT {
              billing_account: $billingAccount,
              source: $source,
              status: "active",
              revision: 1,
              cancel_at_period_end: false,
              correlation_id: $correlationId,
              causation_id: $assignmentCausation
            };
          };
          IF $current != NONE {
            UPDATE $current.id SET
              status = "ended",
              effective_until = $effectiveAt,
              ended_reason = "legacy_quota_migration",
              correlation_id = $correlationId,
              causation_id = $assignmentCausation;
          };
          IF !record::exists($item) {
            CREATE $item CONTENT {
              subscription: $subscription,
              workspace: $workspace,
              plan_revision: $planRevision,
              revision: IF $current = NONE { 1 } ELSE { $current.revision + 1 },
              status: "active",
              effective_from: $effectiveAt,
              correlation_id: $correlationId,
              causation_id: $assignmentCausation
            };
          };
        };
        COMMIT TRANSACTION;
      `,
      {
        assignment: assignmentId,
        workspace: new StringRecordId(workspaceId),
        subscription,
        item,
        billingAccount: new StringRecordId(
          assignment.billing_account_id,
        ),
        planRevision: new StringRecordId(assignment.plan_revision_id),
        source: assignment.source,
        effectiveAt: new DateTime(assignment.effective_at),
        correlationId: `quota-migration:${run.runKey}`,
        assignmentCausation: assignmentId.toString(),
      },
    );
  }

  async listOperations(
    run: StringRecordId,
    options: Readonly<{
      states?: readonly string[];
      cohort?: QuotaMigrationCohort;
      activeOnly?: boolean;
    }> = {},
  ): Promise<readonly QuotaMigrationWorkspaceOperation[]> {
    const result = await this.db.query(
      `
        SELECT
          id,
          run,
          workspace,
          workspace.status AS workspace_status,
          workspace.slug AS workspace_slug,
          workspace.db_name AS db_name,
          state,
          cohort,
          inventory_event_targets,
          assignment,
          fencing_token,
          lease_owner,
          observed_native_generation,
          observed_native_digest
        FROM quota_migration_workspace_operation
        WHERE run = $run
          AND ($states = NONE OR state IN $states)
          AND ($cohort = NONE OR cohort = $cohort)
          AND (!$activeOnly OR workspace.status = "active")
        ORDER BY workspace;
      `,
      {
        run,
        states: options.states ?? undefined,
        cohort: options.cohort,
        activeOnly: options.activeOnly === true,
      },
    );
    return Object.freeze(statementRows(result).map(operationFromRow));
  }

  async loadProjection(workspace: StringRecordId): Promise<Readonly<{
    entitlement: StringRecordId;
    projection: StringRecordId;
    digest: string;
    rules: ReturnType<typeof NativeQuotaRuleSchema.parse>[];
    desiredApplied: boolean;
  }>> {
    const workspaceResult = await this.db.query(
      `
        SELECT desired_entitlement, applied_entitlement,
          desired_quota_projection, applied_quota_projection
        FROM ONLY $workspace;
      `,
      { workspace },
    );
    const workspaceRow = statementRows(workspaceResult, 0)[0];
    if (!workspaceRow) {
      throw new QuotaMigrationError(
        "migration_projection_missing",
        "workspace desired quota projection is missing",
      );
    }
    const desiredEntitlement = requiredRecordId(
      workspaceRow.desired_entitlement,
      "desired entitlement",
    );
    const desiredProjection = requiredRecordId(
      workspaceRow.desired_quota_projection,
      "desired projection",
    );
    const projectionResult = await this.db.query(
      `
        SELECT id, entitlement, canonical_digest, rules
        FROM ONLY $projection;
      `,
      { projection: desiredProjection },
    );
    const projectionRow = statementRows(projectionResult)[0];
    if (!projectionRow) {
      throw new QuotaMigrationError(
        "migration_projection_missing",
        "workspace desired quota projection record is missing",
      );
    }
    return Object.freeze({
      entitlement: desiredEntitlement,
      projection: desiredProjection,
      digest: requiredString(
        projectionRow.canonical_digest,
        "projection digest",
      ),
      rules: Array.isArray(projectionRow.rules)
        ? projectionRow.rules.map((rule) => NativeQuotaRuleSchema.parse(rule))
        : [],
      desiredApplied:
        optionalRecordId(workspaceRow.applied_entitlement)?.toString()
          === desiredEntitlement.toString()
        && optionalRecordId(
            workspaceRow.applied_quota_projection,
          )?.toString() === desiredProjection.toString(),
    });
  }

  async setMaintenanceEvidence(
    run: StringRecordId,
    evidence: QuotaMigrationMaintenanceEvidence,
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE $run SET
          maintenance_evidence = $evidence,
          state = "rebuilding",
          public_reopen_ready = false,
          pause_reason = NONE,
          abort_reason = NONE;
      `,
      { run, evidence },
    );
  }

  async setRunState(
    run: StringRecordId,
    state: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE $run MERGE $fields;
        UPDATE $run SET state = $state;
      `,
      { run, state, fields },
    );
  }

  async setWorkspaceState(
    operation: StringRecordId,
    state: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE $operation MERGE $fields;
        UPDATE $operation SET
          state = $state,
          last_error_code = NONE,
          last_error_details = NONE;
      `,
      { operation, state, fields },
    );
  }

  async claimWorkspace(
    operation: QuotaMigrationWorkspaceOperation,
    workerId: string,
    now: DateTime,
    leaseMs: number,
  ): Promise<QuotaMigrationWorkspaceLease> {
    const leaseExpiresAt = DateTime.fromEpochNanoseconds(
      now.nanoseconds + BigInt(leaseMs) * 1_000_000n,
    );
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $operation;
        LET $claimable = $current != NONE
          AND (
            $current.state INSIDE [
              "native_policy_active",
              "cutover_pending",
              "commit_unknown"
            ]
            OR (
              $current.state = "cutover_processing"
              AND (
                $current.lease_expires_at = NONE
                OR $current.lease_expires_at <= $now
              )
            )
          );
        IF !$claimable {
          THROW "migration-workspace-not-claimable";
        };
        LET $claimed = (
          UPDATE $operation SET
            state = "cutover_processing",
            attempt_count += 1,
            lease_owner = $worker,
            lease_expires_at = $leaseExpiresAt,
            fencing_token += 1
          RETURN AFTER
        )[0];
        RETURN $claimed;
        COMMIT TRANSACTION;
      `,
      {
        operation: operation.id,
        worker: workerId,
        now,
        leaseExpiresAt,
      },
    );
    const row = lastRecord(result);
    if (!row) {
      throw new QuotaMigrationError(
        "migration_workspace_claim_failed",
        "workspace cutover lease was not returned",
      );
    }
    return Object.freeze({
      ...operation,
      state: "cutover_processing",
      workerId,
      fencingToken: integer(row.fencing_token),
      leaseOwner: workerId,
    });
  }

  async settleWorkspace(
    lease: QuotaMigrationWorkspaceLease,
    input: Readonly<{
      state: "native_policy_active" | "commit_unknown" | "native_verified" | "failed";
      observedGeneration?: SurrealInteger;
      observedDigest?: string;
      physicalScanChecksum?: string;
      impactPreview?: Readonly<Record<string, unknown>>;
      errorCode?: string;
      errorDetails?: Readonly<Record<string, unknown>>;
      completedAt: DateTime;
    }>,
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $operation;
        LET $owns = $current != NONE
          AND $current.state = "cutover_processing"
          AND $current.lease_owner = $worker
          AND $current.fencing_token = $fencingToken;
        IF $owns {
          UPDATE $operation SET
            state = $state,
            lease_owner = NONE,
            lease_expires_at = NONE,
            observed_native_generation = $observedGeneration,
            observed_native_digest = $observedDigest,
            physical_scan_checksum = $physicalScanChecksum,
            impact_preview = $impactPreview,
            last_error_code = $errorCode,
            last_error_details = $errorDetails,
            native_verified_at = IF $state = "native_verified" {
              $completedAt
            } ELSE {
              native_verified_at
            };
          IF $state = "native_verified" {
            UPDATE $workspace SET
              quota_migration_state = "native_verified",
              legacy_cleanup_after = $cleanupAfter,
              last_migration_error = NONE,
              last_migration_at = $completedAt;
          };
        };
        RETURN $owns;
        COMMIT TRANSACTION;
      `,
      {
        operation: lease.id,
        workspace: lease.workspace,
        worker: lease.workerId,
        fencingToken: lease.fencingToken,
        state: input.state,
        observedGeneration: input.observedGeneration,
        observedDigest: input.observedDigest,
        physicalScanChecksum: input.physicalScanChecksum,
        impactPreview: input.impactPreview,
        errorCode: input.errorCode,
        errorDetails: input.errorDetails,
        completedAt: input.completedAt,
        cleanupAfter: DateTime.fromEpochNanoseconds(
          input.completedAt.nanoseconds
            + 30n * 24n * 60n * 60n * 1_000_000_000n,
        ),
      },
    );
    return statements(result).flat(Infinity).includes(true);
  }

  async markNativePolicyActive(
    operation: QuotaMigrationWorkspaceOperation,
    input: Readonly<{
      generation: SurrealInteger;
      digest: string;
      scanChecksum: string;
      at: DateTime;
    }>,
  ): Promise<void> {
    await this.db.query(
      `
        BEGIN TRANSACTION;
        UPDATE $operation SET
          state = "native_policy_active",
          observed_native_generation = $generation,
          observed_native_digest = $digest,
          physical_scan_checksum = $scanChecksum,
          native_policy_active_at = $at,
          last_error_code = NONE,
          last_error_details = NONE;
        UPDATE $workspace SET
          quota_migration_state = "native_policy_active",
          last_migration_error = NONE,
          last_migration_at = $at;
        COMMIT TRANSACTION;
      `,
      {
        operation: operation.id,
        workspace: operation.workspace,
        generation: input.generation,
        digest: input.digest,
        scanChecksum: input.scanChecksum,
        at: input.at,
      },
    );
  }

  async markReadyToReopen(
    run: QuotaMigrationRun,
    at: DateTime,
  ): Promise<void> {
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $blockers = array::len(
          SELECT id
          FROM quota_migration_workspace_operation
          WHERE run = $run
            AND workspace.status = "active"
            AND state NOTINSIDE [
              "native_policy_active",
              "cutover_pending",
              "cutover_processing",
              "commit_unknown",
              "native_verified",
              "cleanup_eligible",
              "cleanup_done"
            ]
        );
        IF $blockers > 0 {
          THROW "migration-public-reopen-blocked";
        };
        UPDATE $run SET
          state = "ready_to_reopen",
          public_reopen_ready = true,
          all_native_policy_active_at = $at;
        COMMIT TRANSACTION;
      `,
      { run: run.id, at },
    );
  }

  async startCohort(
    run: QuotaMigrationRun,
    cohort: QuotaMigrationCohort,
    at: DateTime,
  ): Promise<void> {
    const cohortId = deterministicId(
      "quota_migration_cohort",
      run.runKey,
      cohort,
    );
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $previousOpen = array::len(
          SELECT id
          FROM quota_migration_cohort
          WHERE run = $run
            AND ordinal < $ordinal
            AND state != "complete"
        );
        IF $previousOpen > 0 {
          THROW "migration-previous-cohort-incomplete";
        };
        UPDATE $cohort SET
          state = "active",
          started_at = IF started_at = NONE { $at } ELSE { started_at };
        UPDATE $run SET
          state = "cutover",
          current_cohort = $cohortName;
        COMMIT TRANSACTION;
      `,
      {
        run: run.id,
        cohort: cohortId,
        cohortName: cohort,
        ordinal: cohortOrdinal(cohort),
        at,
      },
    );
  }

  async observeCohort(
    run: QuotaMigrationRun,
    cohort: QuotaMigrationCohort,
    at: DateTime,
  ): Promise<DateTime> {
    const observeUntil = DateTime.fromEpochNanoseconds(
      at.nanoseconds
        + BigInt(cohortObservationHours(cohort))
          * 60n * 60n * 1_000_000_000n,
    );
    const cohortId = deterministicId(
      "quota_migration_cohort",
      run.runKey,
      cohort,
    );
    await this.db.query(
      `
        UPDATE $cohort SET
          state = "observing",
          observe_until = $observeUntil;
      `,
      { cohort: cohortId, observeUntil },
    );
    return observeUntil;
  }

  async completeCohort(
    run: QuotaMigrationRun,
    cohort: QuotaMigrationCohort,
    at: DateTime,
  ): Promise<void> {
    const cohortId = deterministicId(
      "quota_migration_cohort",
      run.runKey,
      cohort,
    );
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $cohortState = SELECT * FROM ONLY $cohort;
        IF $cohortState = NONE
          OR $cohortState.state != "observing"
          OR (
            $cohortState.observe_until != NONE
            AND $cohortState.observe_until > $at
          ) {
          THROW "migration-cohort-observation-incomplete";
        };
        LET $blockingSignals = array::len(
          SELECT id
          FROM quota_migration_signal
          WHERE run = $run AND cohort = $cohortName AND blocking = true
        );
        IF $blockingSignals > 0 {
          THROW "migration-cohort-has-blocking-signals";
        };
        UPDATE $cohort SET state = "complete", completed_at = $at;
        COMMIT TRANSACTION;
      `,
      { run: run.id, cohort: cohortId, cohortName: cohort, at },
    );
  }

  async recordSignal(
    run: QuotaMigrationRun,
    cohort: QuotaMigrationCohort | undefined,
    signal: QuotaMigrationSignal,
  ): Promise<void> {
    const checksum = migrationChecksum(signal);
    const signalId = deterministicId(
      "quota_migration_signal",
      run.runKey,
      checksum,
    );
    const blocking = isBlockingMigrationSignal(signal);
    await this.db.query(
      `
        BEGIN TRANSACTION;
        IF !record::exists($signal) {
          CREATE $signal CONTENT {
            run: $run,
            cohort: $cohort,
            workspace: $workspace,
            signal_kind: $kind,
            blocking: $blocking,
            details: $details,
            checksum: $checksum,
            observed_at: $observedAt
          };
        };
        IF $blocking {
          LET $current = SELECT * FROM ONLY $run;
          IF $current.state != "aborted" {
            UPDATE $run SET
              paused_from_state = IF $current.state = "paused" {
                $current.paused_from_state
              } ELSE {
                $current.state
              },
              state = "paused",
              pause_reason = $kind,
              public_reopen_ready = false;
          };
          IF $cohort != NONE {
            UPDATE quota_migration_cohort
              SET state = "paused"
              WHERE run = $run AND cohort = $cohort;
          };
        };
        COMMIT TRANSACTION;
      `,
      {
        signal: signalId,
        run: run.id,
        cohort,
        workspace: signal.workspace_id
          ? new StringRecordId(signal.workspace_id)
          : undefined,
        kind: signal.kind,
        blocking,
        details: signal.details,
        checksum,
        observedAt: new DateTime(signal.observed_at),
      },
    );
  }

  async pauseRun(run: QuotaMigrationRun, reason: string): Promise<void> {
    await this.db.query(
      `
        LET $current = SELECT * FROM ONLY $run;
        IF $current.state != "aborted" {
          UPDATE $run SET
            paused_from_state = IF $current.state = "paused" {
              $current.paused_from_state
            } ELSE {
              $current.state
            },
            state = "paused",
            pause_reason = $reason,
            public_reopen_ready = false;
        };
      `,
      { run: run.id, reason },
    );
  }

  async resumeRun(run: QuotaMigrationRun): Promise<void> {
    await this.db.query(
      `
        LET $current = SELECT * FROM ONLY $run;
        IF $current = NONE OR $current.state != "paused" {
          THROW "migration-run-not-paused";
        };
        UPDATE $run SET
          state = $current.paused_from_state,
          paused_from_state = NONE,
          pause_reason = NONE;
        UPDATE quota_migration_cohort SET state = "active"
          WHERE run = $run
            AND cohort = $current.current_cohort
            AND state = "paused";
      `,
      { run: run.id },
    );
  }

  async abortRun(run: QuotaMigrationRun, reason: string): Promise<void> {
    await this.db.query(
      `
        BEGIN TRANSACTION;
        UPDATE $run SET
          state = "aborted",
          abort_reason = $reason,
          public_reopen_ready = false;
        UPDATE quota_migration_cohort SET state = "aborted"
          WHERE run = $run AND state INSIDE ["active", "observing", "paused"];
        COMMIT TRANSACTION;
      `,
      { run: run.id, reason },
    );
  }

  async markAllNativeVerified(
    run: QuotaMigrationRun,
    at: DateTime,
  ): Promise<void> {
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $remaining = array::len(
          SELECT id
          FROM quota_migration_workspace_operation
          WHERE run = $run
            AND workspace.status = "active"
            AND state NOTINSIDE [
              "native_verified",
              "cleanup_eligible",
              "cleanup_done"
            ]
        );
        IF $remaining > 0 {
          THROW "migration-workspaces-not-verified";
        };
        UPDATE $run SET
          state = "native_verified",
          all_native_verified_at = $at,
          current_cohort = NONE;
        COMMIT TRANSACTION;
      `,
      { run: run.id, at },
    );
  }

  async markCleanupEvidence(
    run: QuotaMigrationRun,
    input: Readonly<{
      fullAuditCleanAt: DateTime;
      productReleaseStableSince: DateTime;
      preNativeCompatibilityBlockedAt: DateTime;
      cleanupNotBefore: DateTime;
    }>,
  ): Promise<void> {
    await this.db.query(
      `
        BEGIN TRANSACTION;
        UPDATE $run SET
          state = "observing",
          full_audit_clean_at = $fullAuditCleanAt,
          product_release_stable_since = $productReleaseStableSince,
          pre_native_compatibility_blocked_at =
            $preNativeCompatibilityBlockedAt,
          cleanup_not_before = $cleanupNotBefore;
        UPDATE workspace SET legacy_cleanup_after = $cleanupNotBefore
          WHERE id IN (
            SELECT VALUE workspace
            FROM quota_migration_workspace_operation
            WHERE run = $run
          );
        COMMIT TRANSACTION;
      `,
      {
        run: run.id,
        fullAuditCleanAt: input.fullAuditCleanAt,
        productReleaseStableSince: input.productReleaseStableSince,
        preNativeCompatibilityBlockedAt:
          input.preNativeCompatibilityBlockedAt,
        cleanupNotBefore: input.cleanupNotBefore,
      },
    );
  }

  async markCleanupEligible(
    run: QuotaMigrationRun,
    at: DateTime,
  ): Promise<void> {
    await this.db.query(
      `
        BEGIN TRANSACTION;
        LET $current = SELECT * FROM ONLY $run;
        IF $current = NONE
          OR $current.all_native_verified_at = NONE
          OR $current.full_audit_clean_at = NONE
          OR $current.product_release_stable_since = NONE
          OR $current.pre_native_compatibility_blocked_at = NONE
          OR $current.cleanup_not_before = NONE
          OR $current.full_audit_clean_at > $at
          OR $current.product_release_stable_since > $at
          OR $current.pre_native_compatibility_blocked_at > $at
          OR $current.cleanup_not_before > $at {
          THROW "migration-cleanup-not-eligible";
        };
        UPDATE $run SET state = "cleanup_eligible";
        UPDATE quota_migration_workspace_operation
          SET state = "cleanup_eligible"
          WHERE run = $run AND state = "native_verified";
        COMMIT TRANSACTION;
      `,
      { run: run.id, at },
    );
  }
}

function recordStringFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.includes(":")) return value;
  const id = optionalRecordId(value);
  return id?.toString();
}
