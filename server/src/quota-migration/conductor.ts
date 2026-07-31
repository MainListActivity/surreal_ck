import {
  QuotaMigrationAssignmentSchema,
  QuotaMigrationInventorySchema,
  QuotaMigrationMaintenanceEvidenceSchema,
  QuotaMigrationSignalSchema,
  extractNativeQuotaError,
  type NativeQuotaInfo,
  type QuotaMigrationAnomaly,
  type QuotaMigrationAssignment,
  type QuotaMigrationAssignmentManifest,
  type QuotaMigrationCohort,
  type QuotaMigrationInventory,
  type QuotaMigrationInventoryWorkspace,
  type QuotaMigrationLegacyEvidence,
  type QuotaMigrationPhysicalScan,
  type ResourceEntitlementRecord,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import {
  SurrealNativeQuotaClient,
  type NativeQuotaMigrationClient,
} from "../db/native-quota/client";
import type {
  EntitlementRefreshPort,
} from "../quota/subscription-lifecycle";
import {
  canonicalNativePolicyDigest,
  compileQuotaPolicy,
} from "../quota/policy-compiler";
import {
  MaterializationWorker,
  type MaterializationWorkerResult,
} from "../quota/sweeps";
import {
  assignMigrationCohorts,
  buildTargetOverage,
  compareNativeUsageToPhysicalScan,
  migrationChecksum,
  QuotaMigrationError,
  verifyManifestChecksum,
} from "./model";
import {
  SurrealLegacyQuotaInventoryReader,
  SurrealQuotaPhysicalScanner,
  type QuotaMigrationWorkspaceQueryClient,
} from "./scanner";
import {
  type QuotaMigrationPlanRevision,
  type QuotaMigrationRun,
  type QuotaMigrationWorkspace,
  type QuotaMigrationWorkspaceLease,
  type QuotaMigrationWorkspaceOperation,
  SurrealQuotaMigrationStore,
} from "./store";

export type QuotaMigrationStorePort = Pick<
  SurrealQuotaMigrationStore,
  | "listWorkspaces"
  | "loadPlanRevision"
  | "persistInventory"
  | "findRun"
  | "inventoryBlockers"
  | "manifestContext"
  | "persistAssignments"
  | "applyAssignmentAuthority"
  | "listOperations"
  | "loadProjection"
  | "setMaintenanceEvidence"
  | "setWorkspaceState"
  | "markNativePolicyActive"
  | "markReadyToReopen"
  | "startCohort"
  | "claimWorkspace"
  | "settleWorkspace"
  | "observeCohort"
  | "completeCohort"
  | "recordSignal"
  | "pauseRun"
  | "resumeRun"
  | "abortRun"
  | "markAllNativeVerified"
  | "markCleanupEvidence"
  | "markCleanupEligible"
>;

export type QuotaMigrationWorkspaceSessionFactory = (
  database: string,
) => Promise<QuotaMigrationWorkspaceQueryClient>;

export interface QuotaMigrationPolicyActivator {
  activate(workspace: StringRecordId): Promise<void>;
}

export class DurableQuotaMigrationPolicyActivator
  implements QuotaMigrationPolicyActivator {
  constructor(
    private readonly store: Pick<QuotaMigrationStorePort, "loadProjection">,
    private readonly worker: Pick<MaterializationWorker, "runOnce">,
    private readonly maxSteps = 10_000,
  ) {}

  async activate(workspace: StringRecordId): Promise<void> {
    for (let step = 0; step < this.maxSteps; step += 1) {
      const projection = await this.store.loadProjection(workspace);
      if (projection.desiredApplied) return;
      const result: MaterializationWorkerResult = await this.worker.runOnce();
      if (result.kind === "idle") {
        throw new QuotaMigrationError(
          "migration_materialization_not_ready",
          "desired native policy has no claimable materialization operation",
          { workspace: workspace.toString() },
        );
      }
      if (
        result.reconcile.kind === "failed"
        || result.reconcile.kind === "external_drift"
      ) {
        throw new QuotaMigrationError(
          result.reconcile.errorCode ?? "migration_materialization_failed",
          "native policy materialization failed during migration",
          {
            workspace: workspace.toString(),
            reconcile_kind: result.reconcile.kind,
          },
          result.reconcile.kind === "external_drift",
        );
      }
    }
    throw new QuotaMigrationError(
      "migration_materialization_step_limit",
      "native policy materialization did not converge",
      { workspace: workspace.toString(), max_steps: this.maxSteps },
    );
  }
}

type Clock = Readonly<{ now(): DateTime }>;

export type QuotaMigrationWorkspaceCutoverOutcome =
  | "verified"
  | "retryable_not_committed"
  | "blocked_unresolved";

export function classifyCommitUnknownReadback(input: Readonly<{
  nativeMatchesPhysicalScan: boolean;
  eventTargetCount: number;
  presentEventCount: number;
  physicalScanUnchanged: boolean;
}>): QuotaMigrationWorkspaceCutoverOutcome {
  if (
    input.nativeMatchesPhysicalScan
    && input.presentEventCount === 0
  ) {
    return "verified";
  }
  if (
    input.nativeMatchesPhysicalScan
    && input.presentEventCount === input.eventTargetCount
    && input.physicalScanUnchanged
  ) {
    return "retryable_not_committed";
  }
  return "blocked_unresolved";
}

export type CreateMigrationInventoryInput = Readonly<{
  runId: string;
  namespace: string;
  draftAssignments: readonly QuotaMigrationAssignment[];
}>;

function iso(value: DateTime): string {
  return new Date(Number(value.nanoseconds / 1_000_000n)).toISOString();
}

function anomaly(
  code: string,
  severity: "discrepancy" | "blocker",
  details: Readonly<Record<string, unknown>> = {},
): QuotaMigrationAnomaly {
  return { code, severity, details: { ...details } };
}

function previewEntitlement(
  workspace: QuotaMigrationWorkspace,
  assignment: QuotaMigrationAssignment,
  plan: QuotaMigrationPlanRevision,
  at: DateTime,
): ResourceEntitlementRecord {
  const entitlement = new StringRecordId(
    `resource_entitlement:migration_preview`,
  );
  return Object.freeze({
    id: entitlement,
    workspace: workspace.id,
    revision: 1,
    source_type: assignment.source,
    plan_revision: plan.id,
    service_mode: "standard",
    rules: plan.rules,
    source_digest: "migration-preview",
    effective_at: new DateTime(assignment.effective_at),
    resolved_at: at,
    correlation_id: "migration-preview",
  });
}

function physicalDiscrepancies(
  legacy: QuotaMigrationLegacyEvidence,
  physical: QuotaMigrationPhysicalScan,
): QuotaMigrationAnomaly[] {
  const anomalies: QuotaMigrationAnomaly[] = [];
  const sheet = physical.tables.find((table) => table.table === "sheet");
  if (
    legacy.counters.sheet_count !== null
    && sheet
    && BigInt(legacy.counters.sheet_count) !== BigInt(sheet.record_count)
  ) {
    anomalies.push(anomaly(
      "legacy_sheet_counter_discrepancy",
      "discrepancy",
      {
        legacy: legacy.counters.sheet_count,
        physical: sheet.record_count,
      },
    ));
  }
  const physicalByTable = new Map(
    physical.tables.map((table) => [table.table, table]),
  );
  for (const counter of legacy.counters.per_sheet_records) {
    if (!counter.table) continue;
    const actual = physicalByTable.get(counter.table);
    if (
      actual
      && BigInt(counter.record_count) !== BigInt(actual.record_count)
    ) {
      anomalies.push(anomaly(
        "legacy_record_counter_discrepancy",
        "discrepancy",
        {
          sheet: counter.sheet,
          table: counter.table,
          legacy: counter.record_count,
          physical: actual.record_count,
        },
      ));
    }
  }
  return anomalies;
}

function errorDetails(error: unknown): Readonly<{
  code: string;
  details: Readonly<Record<string, unknown>>;
  structured: boolean;
}> {
  if (error instanceof QuotaMigrationError) {
    return {
      code: error.code,
      details: error.details,
      structured: true,
    };
  }
  const native = extractNativeQuotaError(error);
  if (native) {
    return {
      code: native.code,
      details: native.details,
      structured: true,
    };
  }
  return {
    code: "migration_transport_or_contract_error",
    details: {
      error_name: error instanceof Error ? error.name : typeof error,
    },
    structured: false,
  };
}

export class LegacyQuotaMigrationConductor {
  private readonly clock: Clock;
  private readonly workerId: string;
  private readonly leaseMs: number;

  constructor(
    private readonly store: QuotaMigrationStorePort,
    private readonly workspaceSession: QuotaMigrationWorkspaceSessionFactory,
    private readonly refresher: EntitlementRefreshPort,
    private readonly policyActivator: QuotaMigrationPolicyActivator,
    options: Readonly<{
      clock?: Clock;
      workerId?: string;
      leaseMs?: number;
    }> = {},
  ) {
    this.clock = options.clock ?? { now: () => DateTime.now() };
    this.workerId = options.workerId
      ?? `quota-migration:${process.pid}:${crypto.randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  async createInventory(
    input: CreateMigrationInventoryInput,
  ): Promise<QuotaMigrationInventory> {
    const draftAssignments = input.draftAssignments.map((assignment) =>
      QuotaMigrationAssignmentSchema.parse(assignment)
    );
    const duplicates = new Set<string>();
    const assignmentByWorkspace = new Map<string, QuotaMigrationAssignment>();
    for (const assignment of draftAssignments) {
      if (assignmentByWorkspace.has(assignment.workspace_id)) {
        duplicates.add(assignment.workspace_id);
      }
      assignmentByWorkspace.set(assignment.workspace_id, assignment);
    }
    if (duplicates.size > 0) {
      throw new QuotaMigrationError(
        "migration_draft_assignment_duplicate",
        "draft assignments contain duplicate workspaces",
        { workspaces: [...duplicates].sort() },
      );
    }

    const workspaces = await this.store.listWorkspaces();
    const knownWorkspaces = new Set(
      workspaces.map((workspace) => workspace.id.toString()),
    );
    const unknownAssignments = draftAssignments.filter(
      (assignment) => !knownWorkspaces.has(assignment.workspace_id),
    );
    if (unknownAssignments.length > 0) {
      throw new QuotaMigrationError(
        "migration_draft_assignment_unknown_workspace",
        "draft assignments contain unknown workspaces",
        {
          workspaces: unknownAssignments.map(
            (assignment) => assignment.workspace_id,
          ),
        },
      );
    }

    const generatedAt = this.clock.now();
    const inventoryWorkspaces: QuotaMigrationInventoryWorkspace[] = [];
    for (const workspace of workspaces) {
      const anomalies: QuotaMigrationAnomaly[] = [];
      const assignment = assignmentByWorkspace.get(workspace.id.toString());
      if (!assignment) {
        anomalies.push(anomaly(
          "migration_assignment_missing",
          workspace.status === "active" ? "blocker" : "discrepancy",
          { workspace: workspace.id.toString() },
        ));
      } else if (
        assignment.database !== workspace.database
        || assignment.workspace_slug !== workspace.slug
      ) {
        anomalies.push(anomaly(
          "migration_assignment_mapping_mismatch",
          "blocker",
          {
            expected_database: workspace.database,
            actual_database: assignment.database,
            expected_slug: workspace.slug,
            actual_slug: assignment.workspace_slug,
          },
        ));
      }

      let legacy: Awaited<
        ReturnType<SurrealLegacyQuotaInventoryReader["read"]>
      >["evidence"] | null = null;
      let physical: QuotaMigrationPhysicalScan | null = null;
      try {
        const session = await this.workspaceSession(workspace.database);
        const [legacyRead, physicalRead] = await Promise.all([
          new SurrealLegacyQuotaInventoryReader(session).read(
            workspace.database,
          ),
          new SurrealQuotaPhysicalScanner(session).scan(),
        ]);
        legacy = legacyRead.evidence;
        physical = physicalRead;
        anomalies.push(...legacyRead.anomalies);
        anomalies.push(
          ...physicalDiscrepancies(
            legacyRead.evidence,
            physicalRead,
          ),
        );
      } catch (error) {
        const failure = errorDetails(error);
        anomalies.push(anomaly(
          "migration_inventory_scan_failed",
          "blocker",
          failure.details,
        ));
      }

      let target: QuotaMigrationInventoryWorkspace["target"] = null;
      if (assignment && physical) {
        const plan = await this.store.loadPlanRevision(
          assignment.plan_revision_id,
        );
        if (!plan) {
          anomalies.push(anomaly(
            "migration_target_plan_missing",
            "blocker",
            { plan_revision: assignment.plan_revision_id },
          ));
        } else if (
          (assignment.source === "contract"
            && plan.templateKind !== "contract")
          || (assignment.source === "manual"
            && plan.templateKind === "contract")
        ) {
          anomalies.push(anomaly(
            "migration_target_plan_source_mismatch",
            "blocker",
            {
              source: assignment.source,
              template_kind: plan.templateKind,
            },
          ));
        } else {
          try {
            const compiled = compileQuotaPolicy({
              projection: {
                id: new StringRecordId(
                  "quota_policy_projection:migration_preview",
                ),
                revision: 1,
                createdAt: generatedAt,
              },
              entitlement: previewEntitlement(
                workspace,
                assignment,
                plan,
                generatedAt,
              ),
            });
            target = {
              plan_revision: plan.id.toString(),
              source: assignment.source,
              policy_digest: compiled.projection.canonical_digest,
              rules: compiled.rules.map((rule) => ({
                ...rule,
                limit: rule.limit.kind === "finite"
                  ? {
                      kind: "finite" as const,
                      value: rule.limit.value.toString(),
                    }
                  : { kind: "unlimited" as const },
              })),
              overage: buildTargetOverage(compiled.rules, physical),
            };
          } catch (error) {
            const failure = errorDetails(error);
            anomalies.push(anomaly(
              "migration_target_compile_failed",
              "blocker",
              { code: failure.code, ...failure.details },
            ));
          }
        }
      }

      const unsigned = {
        workspace_id: workspace.id.toString(),
        workspace_slug: workspace.slug,
        database: workspace.database,
        workspace_status: workspace.status,
        legacy,
        physical,
        target,
        anomalies,
      };
      inventoryWorkspaces.push({
        ...unsigned,
        checksum: migrationChecksum(unsigned),
      });
    }
    const unsignedInventory = {
      format_version: 1 as const,
      run_id: input.runId,
      namespace: input.namespace,
      generated_at: iso(generatedAt),
      workspaces: inventoryWorkspaces,
    };
    const inventory = QuotaMigrationInventorySchema.parse({
      ...unsignedInventory,
      checksum: migrationChecksum(unsignedInventory),
    });
    await this.store.persistInventory(inventory);
    return inventory;
  }

  async importApprovedManifest(
    runKey: string,
    input: unknown,
  ): Promise<void> {
    const manifest = verifyManifestChecksum(input);
    const run = await this.requiredRun(runKey);
    if (manifest.inventory_checksum !== run.inventoryChecksum) {
      throw new QuotaMigrationError(
        "migration_manifest_inventory_mismatch",
        "manifest was not approved against this inventory",
        {
          expected: run.inventoryChecksum,
          actual: manifest.inventory_checksum,
        },
      );
    }
    const blockers = await this.store.inventoryBlockers(run.id);
    if (blockers.length > 0) {
      throw new QuotaMigrationError(
        "migration_inventory_has_blockers",
        "inventory blockers must be resolved before manifest import",
        { blockers },
      );
    }
    const context = await this.store.manifestContext(manifest);
    this.validateManifestContext(manifest, context);
    const cohorts = assignMigrationCohorts(manifest.assignments);
    await this.store.persistAssignments(run, manifest, cohorts);

    for (const assignment of manifest.assignments) {
      await this.store.applyAssignmentAuthority(
        run,
        manifest,
        assignment.workspace_id,
      );
      await this.refresher.refreshWorkspace({
        workspace: new StringRecordId(assignment.workspace_id),
        at: new DateTime(assignment.effective_at),
        operationKind: "manual_assignment",
        actorKind: "operator",
        actorSubject: manifest.approved_by_subject,
        authorizedCapability: "subscription.manage",
        requestId:
          `quota-migration:${manifest.manifest_id}:${assignment.workspace_id}`,
        correlationId: `quota-migration:${run.runKey}`,
        causationId:
          `quota_migration_assignment:${
            migrationChecksum(assignment).slice("sha256:".length, 30)
          }`,
        reason: assignment.evidence_reference,
      });
    }
  }

  async prepareNativeEnforcement(
    runKey: string,
    evidenceInput: unknown,
  ): Promise<void> {
    const evidence = QuotaMigrationMaintenanceEvidenceSchema.parse(
      evidenceInput,
    );
    const run = await this.requiredRun(runKey);
    if (!run.manifestChecksum) {
      throw new QuotaMigrationError(
        "migration_manifest_not_imported",
        "approved assignment manifest must be imported before rebuild",
      );
    }
    await this.store.setMaintenanceEvidence(run.id, evidence);

    const systemSession = await this.workspaceSession("_system");
    const systemNative = new SurrealNativeQuotaClient(systemSession);
    await systemNative.rebuild("_system");
    const [systemInfo, systemScan] = await Promise.all([
      systemNative.info("_system"),
      new SurrealQuotaPhysicalScanner(systemSession).scan(),
    ]);
    await this.assertNativeMatchesScan(
      run,
      undefined,
      systemInfo,
      systemScan,
    );

    const operations = await this.store.listOperations(run.id, {
      activeOnly: true,
    });
    for (const operation of operations) {
      await this.store.setWorkspaceState(operation.id, "rebuilding");
      const session = await this.workspaceSession(operation.database);
      const native = new SurrealNativeQuotaClient(session);
      await native.rebuild(operation.database);
      const [rebuildInfo, rebuildScan] = await Promise.all([
        native.info(operation.database),
        new SurrealQuotaPhysicalScanner(session).scan(),
      ]);
      await this.assertNativeMatchesScan(
        run,
        operation,
        rebuildInfo,
        rebuildScan,
      );
      await this.store.setWorkspaceState(
        operation.id,
        "rebuild_verified",
        { physical_scan_checksum: rebuildScan.scan_checksum },
      );

      await this.policyActivator.activate(operation.workspace);
      const projection = await this.store.loadProjection(operation.workspace);
      if (!projection.desiredApplied) {
        throw new QuotaMigrationError(
          "migration_policy_pointer_not_applied",
          "native policy readback completed without applied pointer convergence",
          { workspace: operation.workspace.toString() },
        );
      }
      const [info, scan] = await Promise.all([
        native.info(operation.database),
        new SurrealQuotaPhysicalScanner(session).scan(),
      ]);
      await this.assertNativeMatchesScan(
        run,
        operation,
        info,
        scan,
        projection.digest,
      );
      if (!info.policy) {
        throw new QuotaMigrationError(
          "migration_native_policy_missing",
          "native policy disappeared after materialization",
          { workspace: operation.workspace.toString() },
          true,
        );
      }
      await this.store.markNativePolicyActive(operation, {
        generation: info.policy.generation,
        digest: projection.digest,
        scanChecksum: scan.scan_checksum,
        at: this.clock.now(),
      });
    }

    await this.assertPublicReopenReady(runKey);
  }

  async assertPublicReopenReady(runKey: string): Promise<void> {
    const run = await this.requiredRun(runKey);
    const operations = await this.store.listOperations(run.id, {
      activeOnly: true,
    });
    for (const operation of operations) {
      if (
        ![
          "native_policy_active",
          "cutover_pending",
          "native_verified",
          "cleanup_eligible",
          "cleanup_done",
        ].includes(operation.state)
      ) {
        throw new QuotaMigrationError(
          "migration_public_reopen_blocked",
          "active workspace has no readback-verified native policy",
          {
            workspace: operation.workspace.toString(),
            state: operation.state,
          },
        );
      }
      const session = await this.workspaceSession(operation.database);
      const native = new SurrealNativeQuotaClient(session);
      const projection = await this.store.loadProjection(operation.workspace);
      const [info, scan] = await Promise.all([
        native.info(operation.database),
        new SurrealQuotaPhysicalScanner(session).scan(),
      ]);
      await this.assertNativeMatchesScan(
        run,
        operation,
        info,
        scan,
        projection.digest,
      );
    }
    await this.store.markReadyToReopen(run, this.clock.now());
  }

  async cutoverCohort(
    runKey: string,
    cohort: QuotaMigrationCohort,
  ): Promise<DateTime> {
    const run = await this.requiredRun(runKey);
    if (
      !run.publicReopenReady
      && run.state !== "cutover"
      && run.state !== "ready_to_reopen"
    ) {
      throw new QuotaMigrationError(
        "migration_cutover_not_ready",
        "all active workspaces must have native enforcement before cutover",
        { state: run.state },
      );
    }
    await this.store.startCohort(run, cohort, this.clock.now());
    const operations = await this.store.listOperations(run.id, {
      cohort,
      activeOnly: true,
    });
    for (const operation of operations) {
      if (
        operation.state === "native_verified"
        || operation.state === "cleanup_eligible"
        || operation.state === "cleanup_done"
      ) {
        continue;
      }
      const outcome = await this.cutoverWorkspace(run, operation);
      if (outcome === "retryable_not_committed") {
        throw new QuotaMigrationError(
          "migration_cutover_not_committed",
          "cutover transaction did not commit; retry the workspace before cohort observation",
          { workspace: operation.workspace.toString(), cohort },
        );
      }
      if (outcome === "blocked_unresolved") {
        throw new QuotaMigrationError(
          "migration_commit_unknown_unresolved",
          "cutover commit state is unresolved; the migration run was paused",
          { workspace: operation.workspace.toString(), cohort },
          true,
        );
      }
    }
    return await this.store.observeCohort(run, cohort, this.clock.now());
  }

  async completeCohort(
    runKey: string,
    cohort: QuotaMigrationCohort,
  ): Promise<void> {
    const run = await this.requiredRun(runKey);
    await this.store.completeCohort(run, cohort, this.clock.now());
    if (cohort === "remainder") {
      await this.store.markAllNativeVerified(run, this.clock.now());
    }
  }

  async recordSignal(
    runKey: string,
    cohort: QuotaMigrationCohort | undefined,
    input: unknown,
  ): Promise<void> {
    const signal = QuotaMigrationSignalSchema.parse(input);
    await this.store.recordSignal(
      await this.requiredRun(runKey),
      cohort,
      signal,
    );
  }

  async pause(runKey: string, reason: string): Promise<void> {
    await this.store.pauseRun(await this.requiredRun(runKey), reason);
  }

  async resume(runKey: string): Promise<void> {
    await this.store.resumeRun(await this.requiredRun(runKey));
  }

  async abort(runKey: string, reason: string): Promise<void> {
    await this.store.abortRun(await this.requiredRun(runKey), reason);
  }

  async recordCleanupEvidence(
    runKey: string,
    input: Readonly<{
      fullAuditCleanAt: DateTime;
      productReleaseStableSince: DateTime;
      preNativeCompatibilityBlockedAt: DateTime;
    }>,
  ): Promise<DateTime> {
    const run = await this.requiredRun(runKey);
    if (
      !run.allNativeVerifiedAt
      || (
        run.state !== "native_verified"
        && run.state !== "observing"
        && run.state !== "cleanup_eligible"
      )
    ) {
      throw new QuotaMigrationError(
        "migration_cleanup_evidence_too_early",
        "all active workspaces must be native_verified first",
        { state: run.state },
      );
    }
    const recordedAt = this.clock.now();
    const futureEvidence = Object.entries(input)
      .filter(([, value]) => value.nanoseconds > recordedAt.nanoseconds)
      .map(([field]) => field);
    if (futureEvidence.length > 0) {
      throw new QuotaMigrationError(
        "migration_cleanup_evidence_in_future",
        "cleanup evidence timestamps cannot be in the future",
        { fields: futureEvidence },
      );
    }
    const base = [
      run.allNativeVerifiedAt.nanoseconds,
      input.productReleaseStableSince.nanoseconds,
    ].reduce((left, right) => left > right ? left : right);
    const cleanupNotBefore = DateTime.fromEpochNanoseconds(
      base + 30n * 24n * 60n * 60n * 1_000_000_000n,
    );
    await this.store.markCleanupEvidence(run, {
      ...input,
      cleanupNotBefore,
    });
    return cleanupNotBefore;
  }

  async markCleanupEligible(runKey: string): Promise<void> {
    await this.store.markCleanupEligible(
      await this.requiredRun(runKey),
      this.clock.now(),
    );
  }

  private async cutoverWorkspace(
    run: QuotaMigrationRun,
    operation: QuotaMigrationWorkspaceOperation,
  ): Promise<QuotaMigrationWorkspaceCutoverOutcome> {
    const lease = await this.store.claimWorkspace(
      operation,
      this.workerId,
      this.clock.now(),
      this.leaseMs,
    );
    const session = await this.workspaceSession(operation.database);
    const native = new SurrealNativeQuotaClient(session);
    try {
      const projection = await this.store.loadProjection(operation.workspace);
      const [before, scan, legacy] = await Promise.all([
        native.info(operation.database),
        new SurrealQuotaPhysicalScanner(session).scan(),
        new SurrealLegacyQuotaInventoryReader(session).read(
          operation.database,
        ),
      ]);
      await this.assertNativeMatchesScan(
        run,
        operation,
        before,
        scan,
        projection.digest,
      );
      if (!before.policy) {
        throw new QuotaMigrationError(
          "migration_native_policy_missing",
          "workspace cutover requires an active native policy",
          {},
          true,
        );
      }
      const currentTargets = legacy.evidence.event_targets
        .map((target) => target.table)
        .sort();
      const inventoryTargets = [...operation.inventoryEventTargets].sort();
      if (JSON.stringify(currentTargets) !== JSON.stringify(inventoryTargets)) {
        throw new QuotaMigrationError(
          "migration_legacy_event_target_drift",
          "legacy event target set changed after inventory",
          { inventory: inventoryTargets, current: currentTargets },
          true,
        );
      }
      const impact = {
        overage: buildTargetOverage(projection.rules, scan),
      };
      try {
        await native.cutoverLegacyQuotaEvents({
          database: operation.database,
          rules: projection.rules,
          expectedGeneration: before.policy.generation,
          legacyEventTables: currentTargets,
        });
      } catch (error) {
        const resolution = await this.resolveCommitUnknown(
          run,
          lease,
          native,
          session,
          projection.digest,
          currentTargets,
          scan,
          impact,
          error,
        );
        if (resolution) return resolution;
        throw error;
      }
      await this.verifyAndSettleCutover(
        run,
        lease,
        native,
        session,
        projection.digest,
        currentTargets,
        impact,
      );
      return "verified";
    } catch (error) {
      const failure = errorDetails(error);
      await this.store.settleWorkspace(lease, {
        state: error instanceof QuotaMigrationError && error.pausesRun
          ? "failed"
          : "native_policy_active",
        errorCode: failure.code,
        errorDetails: failure.details,
        completedAt: this.clock.now(),
      });
      if (error instanceof QuotaMigrationError && error.pausesRun) {
        await this.store.recordSignal(run, operation.cohort, {
          kind: "unknown_drift",
          workspace_id: operation.workspace.toString(),
          details: { code: error.code, ...error.details },
          observed_at: iso(this.clock.now()),
        });
      }
      throw error;
    }
  }

  private async resolveCommitUnknown(
    run: QuotaMigrationRun,
    lease: QuotaMigrationWorkspaceLease,
    native: NativeQuotaMigrationClient,
    session: QuotaMigrationWorkspaceQueryClient,
    digest: string,
    eventTargets: readonly string[],
    beforeScan: QuotaMigrationPhysicalScan,
    impact: Readonly<Record<string, unknown>>,
    originalError: unknown,
  ): Promise<QuotaMigrationWorkspaceCutoverOutcome | undefined> {
    try {
      const [info, events, scan] = await Promise.all([
        native.info(lease.database),
        native.readLegacyQuotaEvents(lease.database, eventTargets),
        new SurrealQuotaPhysicalScanner(session).scan(),
      ]);
      const compared = compareNativeUsageToPhysicalScan(info, scan, digest);
      const present = eventTargets.filter((table) => events.get(table));
      const resolution = classifyCommitUnknownReadback({
        nativeMatchesPhysicalScan: compared.ok,
        eventTargetCount: eventTargets.length,
        presentEventCount: present.length,
        physicalScanUnchanged:
          scan.scan_checksum === beforeScan.scan_checksum,
      });
      if (resolution === "verified") {
        await this.settleVerified(
          lease,
          info,
          scan,
          impact,
        );
        return resolution;
      }
      if (resolution === "retryable_not_committed") {
        const failure = errorDetails(originalError);
        await this.store.settleWorkspace(lease, {
          state: "native_policy_active",
          observedGeneration: info.policy?.generation,
          observedDigest: digest,
          physicalScanChecksum: scan.scan_checksum,
          impactPreview: impact,
          errorCode: "migration_cutover_not_committed",
          errorDetails: failure.details,
          completedAt: this.clock.now(),
        });
        return resolution;
      }
      await this.store.settleWorkspace(lease, {
        state: "commit_unknown",
        observedGeneration: info.policy?.generation,
        observedDigest: info.policy
          ? canonicalNativePolicyDigest(info.policy.rules)
          : undefined,
        physicalScanChecksum: scan.scan_checksum,
        impactPreview: impact,
        errorCode: "migration_commit_unknown_unresolved",
        errorDetails: {
          present_events: present,
          comparison_errors: compared.errors,
        },
        completedAt: this.clock.now(),
      });
      await this.store.recordSignal(run, lease.cohort, {
        kind: "unknown_drift",
        workspace_id: lease.workspace.toString(),
        details: {
          phase: "commit_readback",
          present_events: present,
          comparison_errors: compared.errors,
        },
        observed_at: iso(this.clock.now()),
      });
      return resolution;
    } catch {
      return undefined;
    }
  }

  private async verifyAndSettleCutover(
    run: QuotaMigrationRun,
    lease: QuotaMigrationWorkspaceLease,
    native: NativeQuotaMigrationClient,
    session: QuotaMigrationWorkspaceQueryClient,
    digest: string,
    eventTargets: readonly string[],
    impact: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const [info, events, scan] = await Promise.all([
      native.info(lease.database),
      native.readLegacyQuotaEvents(lease.database, eventTargets),
      new SurrealQuotaPhysicalScanner(session).scan(),
    ]);
    await this.assertNativeMatchesScan(
      run,
      lease,
      info,
      scan,
      digest,
    );
    const present = eventTargets.filter((table) => events.get(table));
    if (present.length > 0) {
      throw new QuotaMigrationError(
        "migration_legacy_event_readback_failed",
        "legacy quota events remain after committed cutover",
        { tables: present },
        true,
      );
    }
    await this.settleVerified(lease, info, scan, impact);
  }

  private async settleVerified(
    lease: QuotaMigrationWorkspaceLease,
    info: NativeQuotaInfo,
    scan: QuotaMigrationPhysicalScan,
    impact: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (!info.policy) {
      throw new QuotaMigrationError(
        "migration_native_policy_missing",
        "native policy missing during cutover settlement",
        {},
        true,
      );
    }
    const accepted = await this.store.settleWorkspace(lease, {
      state: "native_verified",
      observedGeneration: info.policy.generation,
      observedDigest: canonicalNativePolicyDigest(info.policy.rules),
      physicalScanChecksum: scan.scan_checksum,
      impactPreview: impact,
      completedAt: this.clock.now(),
    });
    if (!accepted) {
      throw new QuotaMigrationError(
        "migration_workspace_lease_lost",
        "workspace cutover lease was lost before settlement",
      );
    }
  }

  private async assertNativeMatchesScan(
    run: QuotaMigrationRun,
    operation: QuotaMigrationWorkspaceOperation | undefined,
    info: NativeQuotaInfo,
    scan: QuotaMigrationPhysicalScan,
    expectedDigest?: string,
  ): Promise<void> {
    const comparison = compareNativeUsageToPhysicalScan(
      info,
      scan,
      expectedDigest,
    );
    if (comparison.ok) return;
    const ledgerCorrupt = comparison.errors.some(
      (error) => error.code === "ledger_corrupt",
    );
    await this.store.recordSignal(run, operation?.cohort, {
      kind: ledgerCorrupt ? "ledger_corrupt" : "counter_mismatch",
      workspace_id: operation?.workspace.toString(),
      details: {
        database: info.database,
        errors: comparison.errors,
      },
      observed_at: iso(this.clock.now()),
    });
    throw new QuotaMigrationError(
      ledgerCorrupt ? "migration_ledger_corrupt" : "migration_counter_mismatch",
      "native quota usage does not match independent physical scan",
      { errors: comparison.errors },
      true,
    );
  }

  private validateManifestContext(
    manifest: QuotaMigrationAssignmentManifest,
    context: Awaited<
      ReturnType<QuotaMigrationStorePort["manifestContext"]>
    >,
  ): void {
    if (!context.approverAuthorized) {
      throw new QuotaMigrationError(
        "migration_manifest_approver_unauthorized",
        "manifest approver lacks subscription.manage",
      );
    }
    const assignments = new Map<string, QuotaMigrationAssignment>();
    for (const assignment of manifest.assignments) {
      if (assignments.has(assignment.workspace_id)) {
        throw new QuotaMigrationError(
          "migration_manifest_duplicate_assignment",
          "workspace has more than one approved assignment",
          { workspace: assignment.workspace_id },
        );
      }
      assignments.set(assignment.workspace_id, assignment);
    }
    const workspaces = new Map(
      context.workspaces.map((workspace) => [
        workspace.id.toString(),
        workspace,
      ]),
    );
    const missing = context.workspaces
      .filter((workspace) =>
        workspace.status === "active"
        && !assignments.has(workspace.id.toString())
      )
      .map((workspace) => workspace.id.toString());
    if (missing.length > 0) {
      throw new QuotaMigrationError(
        "migration_manifest_active_assignment_missing",
        "every active workspace requires exactly one approved assignment",
        { workspaces: missing },
      );
    }
    for (const assignment of manifest.assignments) {
      const workspace = workspaces.get(assignment.workspace_id);
      if (!workspace) {
        throw new QuotaMigrationError(
          "migration_manifest_unknown_workspace",
          "manifest contains an unknown workspace",
          { workspace: assignment.workspace_id },
        );
      }
      if (
        workspace.database !== assignment.database
        || workspace.slug !== assignment.workspace_slug
      ) {
        throw new QuotaMigrationError(
          "migration_manifest_mapping_mismatch",
          "workspace/database mapping changed after inventory",
          { workspace: assignment.workspace_id },
        );
      }
      const plan = context.plans.get(assignment.plan_revision_id);
      if (!plan) {
        throw new QuotaMigrationError(
          "migration_manifest_plan_missing",
          "manifest plan revision does not exist",
          { plan_revision: assignment.plan_revision_id },
        );
      }
      if (
        (assignment.source === "contract"
          && plan.templateKind !== "contract")
        || (assignment.source === "manual"
          && plan.templateKind === "contract")
      ) {
        throw new QuotaMigrationError(
          "migration_manifest_source_mismatch",
          "manifest source does not match plan template kind",
          {
            source: assignment.source,
            template_kind: plan.templateKind,
          },
        );
      }
      if (!context.billingAccounts.has(assignment.billing_account_id)) {
        throw new QuotaMigrationError(
          "migration_manifest_billing_account_missing",
          "manifest billing account is missing or closed",
          { billing_account: assignment.billing_account_id },
        );
      }
    }
  }

  private async requiredRun(runKey: string): Promise<QuotaMigrationRun> {
    const run = await this.store.findRun(runKey);
    if (!run) {
      throw new QuotaMigrationError(
        "migration_run_not_found",
        "quota migration run does not exist",
        { run_key: runKey },
      );
    }
    if (run.state === "aborted") {
      throw new QuotaMigrationError(
        "migration_run_aborted",
        "quota migration run is aborted",
        { run_key: runKey },
      );
    }
    return run;
  }
}
