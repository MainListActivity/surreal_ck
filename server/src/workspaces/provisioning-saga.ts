import {
  NATIVE_QUOTA_EXPECTED_CONTRACT,
  type ProductQuotaRule,
  type ResourceEntitlementRecord,
} from "@surreal-ck/shared/native-quota";
import type { WorkspaceQuotaMigrationState } from "@surreal-ck/shared/workspace-migration-manifest";
import { DateTime, StringRecordId } from "surrealdb";
import type { NativeQuotaClient } from "../db/native-quota/client";
import {
  canonicalNativePolicyDigest,
  compileQuotaPolicy,
  type CompiledQuotaPolicy,
} from "../quota/policy-compiler";
import {
  resolveResourceEntitlement,
  type EntitlementBaseCandidate,
  type EntitlementPlanRevision,
  type ResourceEntitlementResolution,
} from "../quota/entitlement-resolver";

export type ProvisioningStage =
  | "reserved"
  | "entitlement_resolved"
  | "policy_applied"
  | "template_applied"
  | "owner_seeded"
  | "index_ready"
  | "completed";

export type ProvisioningWorkspaceRecord = Readonly<{
  id: StringRecordId;
  dbName: string;
  slug: string;
  name: string;
  ownerSubject: string;
  status: "provisioning" | "active" | "provisioning_error";
  stage: ProvisioningStage | null;
  quotaMigrationState: WorkspaceQuotaMigrationState;
  desiredEntitlement?: StringRecordId;
  appliedEntitlement?: StringRecordId;
  desiredQuotaProjection?: StringRecordId;
  appliedQuotaProjection?: StringRecordId;
  legacyCleanupAfter?: DateTime;
}>;

export type ExplicitResourceSource = Readonly<{
  /** Seeded or published plan key (trial / plus / pro / max). */
  planKey: string;
  /**
   * commercial paid/manual/contract or trial. Defaults:
   * trial plan → trial; others → manual (explicit assignment).
   */
  sourceKind?: "trial" | "manual" | "paid" | "contract";
}>;

export type ProvisioningPlanLookup = Readonly<{
  planRevision: EntitlementPlanRevision;
  rules: readonly ProductQuotaRule[];
}>;

export type ProvisioningControlPlane = {
  reserveWorkspace(input: {
    slug: string;
    name: string;
    ownerSubject: string;
    email: string;
    dbName: string;
  }): Promise<
    | {
        kind: "reserved";
        workspace: ProvisioningWorkspaceRecord;
        resumed: boolean;
      }
    | { kind: "slug-conflict" }
    | { kind: "db-name-conflict" }
  >;
  loadPlan(planKey: string): Promise<ProvisioningPlanLookup | null>;
  persistResourceSource(input: {
    workspace: ProvisioningWorkspaceRecord;
    planKey: string;
    sourceKind: "trial" | "manual" | "paid" | "contract";
    planRevision: EntitlementPlanRevision;
    ownerSubject: string;
    email: string;
    /** Same effective timestamp used by entitlement resolution. */
    effectiveAt: DateTime;
    correlationId: string;
  }): Promise<EntitlementBaseCandidate>;
  persistEntitlementAndProjection(input: {
    workspace: ProvisioningWorkspaceRecord;
    entitlement: ResourceEntitlementRecord;
    projection: CompiledQuotaPolicy["projection"];
    correlationId: string;
  }): Promise<{
    entitlementId: StringRecordId;
    projectionId: StringRecordId;
  }>;
  markStage(input: {
    workspaceId: StringRecordId;
    stage: ProvisioningStage;
    status?: "provisioning" | "active" | "provisioning_error";
    quotaMigrationState?: WorkspaceQuotaMigrationState;
    errorCode?: string | null;
    error?: string | null;
    desiredEntitlement?: StringRecordId;
    appliedEntitlement?: StringRecordId;
    desiredQuotaProjection?: StringRecordId;
    appliedQuotaProjection?: StringRecordId;
    legacyCleanupAfter?: DateTime;
  }): Promise<void>;
  markAppliedFromNative(input: {
    workspaceId: StringRecordId;
    entitlementId: StringRecordId;
    projectionId: StringRecordId;
    digest: string;
    generation?: number | bigint;
    ledgerState: string;
    usageTrusted: boolean;
  }): Promise<void>;
  createPhysicalDatabase(dbName: string): Promise<
    | { kind: "created" }
    | { kind: "db-name-conflict" }
  >;
  dropPhysicalDatabase(dbName: string): Promise<void>;
  /** Optional: free slug/db_name reservation after a physical name collision. */
  releaseReservation?(workspace: ProvisioningWorkspaceRecord): Promise<void>;
};

export type ProvisioningSagaInput = Readonly<{
  subject: string;
  email: string;
  name: string;
  slug: string;
  dbName: string;
  resourceSource: ExplicitResourceSource;
  correlationId?: string;
}>;

export type ProvisioningSagaResult =
  | {
      kind: "ready_for_template";
      workspace: ProvisioningWorkspaceRecord;
      entitlementId: StringRecordId;
      projectionId: StringRecordId;
      correlationId: string;
    }
  | { kind: "slug-conflict" }
  | { kind: "db-name-conflict" }
  | {
      kind: "no-resource-source";
      code: string;
      message: string;
      workspaceId?: string;
      dbName?: string;
    }
  | {
      kind: "provisioning_error";
      code: string;
      message: string;
      workspaceId?: string;
      dbName: string;
    };

function defaultSourceKind(
  planKey: string,
  explicit?: ExplicitResourceSource["sourceKind"],
): "trial" | "manual" | "paid" | "contract" {
  if (explicit) return explicit;
  if (planKey === "trial") return "trial";
  return "manual";
}

function isReadyLedger(info: {
  ledger: { state: string; usage_trusted: boolean };
  usage: unknown;
}): boolean {
  return (
    info.ledger.state === "ready"
    && info.ledger.usage_trusted
    && info.usage !== null
  );
}

/**
 * Fail-closed stages before workspace templates:
 * reserve → resolve entitlement → compile projection → define db →
 * apply native policy → INFO/ledger ready.
 *
 * Template / owner / index / active / scope remain in create-workspace so
 * existing template loaders stay at that boundary.
 */
export async function runProvisioningQuotaSaga(
  controlPlane: ProvisioningControlPlane,
  native: NativeQuotaClient,
  input: ProvisioningSagaInput,
  options: Readonly<{
    now?: DateTime;
    nextIds?: () => {
      entitlementId: StringRecordId;
      projectionId: StringRecordId;
      entitlementRevision: number;
      projectionRevision: number;
    };
  }> = {},
): Promise<ProvisioningSagaResult> {
  const correlationId = input.correlationId ?? crypto.randomUUID();
  const now = options.now ?? DateTime.now();

  if (!input.resourceSource?.planKey?.trim()) {
    return {
      kind: "no-resource-source",
      code: "workspace-resource-source-required",
      message: "explicit resource source (planKey) is required; Plus is never implicit",
    };
  }

  const reserved = await controlPlane.reserveWorkspace({
    slug: input.slug,
    name: input.name,
    ownerSubject: input.subject,
    email: input.email,
    dbName: input.dbName,
  });
  if (reserved.kind !== "reserved") return reserved;

  let workspace = reserved.workspace;
  const plan = await controlPlane.loadPlan(input.resourceSource.planKey);
  if (!plan) {
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "reserved",
      status: "provisioning_error",
      errorCode: "workspace-plan-not-found",
      error: `plan not found: ${input.resourceSource.planKey}`,
    });
    return {
      kind: "no-resource-source",
      code: "workspace-plan-not-found",
      message: `plan not found: ${input.resourceSource.planKey}`,
      workspaceId: workspace.id.toString(),
      dbName: workspace.dbName,
    };
  }

  const sourceKind = defaultSourceKind(
    input.resourceSource.planKey,
    input.resourceSource.sourceKind,
  );
  const validSourceForTemplate =
    (sourceKind === "trial" && plan.planRevision.template_kind === "trial")
    || (
      sourceKind !== "trial"
      && plan.planRevision.template_kind === "commercial"
    );
  if (!validSourceForTemplate) {
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: workspace.stage ?? "reserved",
      status: "provisioning_error",
      errorCode: "workspace-resource-source-mismatch",
      error: "resource source kind does not match the selected plan",
    });
    return {
      kind: "no-resource-source",
      code: "workspace-resource-source-mismatch",
      message: "resource source kind does not match the selected plan",
      workspaceId: workspace.id.toString(),
      dbName: workspace.dbName,
    };
  }

  try {
    const candidate = await controlPlane.persistResourceSource({
      workspace,
      planKey: input.resourceSource.planKey,
      sourceKind,
      planRevision: plan.planRevision,
      ownerSubject: input.subject,
      email: input.email,
      effectiveAt: now,
      correlationId,
    });

    const ids = options.nextIds?.() ?? {
      entitlementId: new StringRecordId(
        `resource_entitlement:${workspace.dbName}_v1`,
      ),
      projectionId: new StringRecordId(
        `quota_policy_projection:${workspace.dbName}_v1`,
      ),
      entitlementRevision: 1,
      projectionRevision: 1,
    };

    const resolution: ResourceEntitlementResolution = resolveResourceEntitlement({
      workspace: workspace.id,
      at: now,
      previouslyActivated: false,
      candidates: [candidate],
      nextEntitlement: {
        id: ids.entitlementId,
        revision: ids.entitlementRevision,
      },
      correlationId,
      causationId: `provision:${workspace.dbName}`,
    });

    if (resolution.kind !== "resolved") {
      await controlPlane.markStage({
        workspaceId: workspace.id,
        stage: "reserved",
        status: "provisioning_error",
        errorCode: "workspace-no-eligible-source",
        error: "no eligible resource entitlement source",
      });
      return {
        kind: "no-resource-source",
        code: "workspace-no-eligible-source",
        message: "no eligible resource entitlement source",
        workspaceId: workspace.id.toString(),
        dbName: workspace.dbName,
      };
    }

    // Compiler requires full managed coverage; prefer plan rules when candidate
    // only carries a partial slice (resolver returns plan rules as-is).
    const entitlement: ResourceEntitlementRecord = {
      ...resolution.entitlement,
      rules: resolution.entitlement.rules.length > 0
        ? resolution.entitlement.rules
        : plan.rules,
    };

    const compiled = compileQuotaPolicy({
      projection: {
        id: ids.projectionId,
        revision: ids.projectionRevision,
        createdAt: now,
      },
      entitlement,
    });

    await controlPlane.persistEntitlementAndProjection({
      workspace,
      entitlement,
      projection: compiled.projection,
      correlationId,
    });

    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "entitlement_resolved",
      status: "provisioning",
      desiredEntitlement: entitlement.id,
      desiredQuotaProjection: compiled.projection.id,
      errorCode: null,
      error: null,
    });

    const physical = await controlPlane.createPhysicalDatabase(workspace.dbName);
    if (physical.kind === "db-name-conflict") {
      if (reserved.resumed) {
        // A recoverable reservation owns this database name; continue from the
        // persisted stage instead of treating its own database as a collision.
      } else {
      // Free the reserved slug/db_name so the outer allocator can retry with a
      // new physical name without permanent slug capture.
        await controlPlane.releaseReservation?.(workspace).catch(() => undefined);
        return { kind: "db-name-conflict" };
      }
    }

    // INFO-first makes a resumed operation idempotent and refuses to overwrite
    // unexpected native drift without an explicit operator action.
    let info = await native.info(workspace.dbName);
    const initialDigest = info.policy
      ? canonicalNativePolicyDigest(info.policy.rules)
      : undefined;
    if (!info.policy) {
      await native.applyPolicy({
        database: workspace.dbName,
        rules: compiled.projection.rules,
      });
      info = await native.info(workspace.dbName);
    } else if (initialDigest !== compiled.projection.canonical_digest) {
      throw new Error(
        "existing native quota policy does not match the provisioning projection",
      );
    }

    if (!isReadyLedger(info)) {
      await native.rebuild(workspace.dbName);
      info = await native.info(workspace.dbName);
    }

    const observedDigest = info.policy
      ? canonicalNativePolicyDigest(info.policy.rules)
      : undefined;
    if (
      !info.policy
      || observedDigest !== compiled.projection.canonical_digest
      || !isReadyLedger(info)
    ) {
      await controlPlane.markStage({
        workspaceId: workspace.id,
        stage: "entitlement_resolved",
        status: "provisioning_error",
        errorCode: "workspace-policy-readback-failed",
        error: "native policy INFO readback did not match desired projection",
        quotaMigrationState: "native_applied",
      });
      return {
        kind: "provisioning_error",
        code: "workspace-policy-readback-failed",
        message: "native policy INFO readback did not match desired projection",
        workspaceId: workspace.id.toString(),
        dbName: workspace.dbName,
      };
    }

    await controlPlane.markAppliedFromNative({
      workspaceId: workspace.id,
      entitlementId: entitlement.id,
      projectionId: compiled.projection.id,
      digest: compiled.projection.canonical_digest,
      generation: info.policy.generation,
      ledgerState: info.ledger.state,
      usageTrusted: info.ledger.usage_trusted,
    });

    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "policy_applied",
      status: "provisioning",
      // Greenfield: INFO match ⇒ native_verified so cleanup migration may run
      // before scope opens.
      quotaMigrationState: "native_verified",
      desiredEntitlement: entitlement.id,
      appliedEntitlement: entitlement.id,
      desiredQuotaProjection: compiled.projection.id,
      appliedQuotaProjection: compiled.projection.id,
      legacyCleanupAfter: now,
      errorCode: null,
      error: null,
    });

    return {
      kind: "ready_for_template",
      workspace: {
        ...workspace,
        stage: "policy_applied",
        quotaMigrationState: "native_verified",
        desiredEntitlement: entitlement.id,
        appliedEntitlement: entitlement.id,
        desiredQuotaProjection: compiled.projection.id,
        appliedQuotaProjection: compiled.projection.id,
        legacyCleanupAfter: now,
      },
      entitlementId: entitlement.id,
      projectionId: compiled.projection.id,
      correlationId,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: workspace.stage ?? "reserved",
      status: "provisioning_error",
      errorCode: "workspace-provisioning-failed",
      error: message,
    }).catch(() => undefined);

    // Capability / contract mismatch: do not leave an unlimited accessible db.
    if (
      message.includes("native_quota")
      || message.includes(NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName)
    ) {
      await controlPlane.dropPhysicalDatabase(workspace.dbName).catch(() => undefined);
    }

    return {
      kind: "provisioning_error",
      code: "workspace-provisioning-failed",
      message,
      workspaceId: workspace.id.toString(),
      dbName: workspace.dbName,
    };
  }
}
