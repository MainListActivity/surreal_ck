import {
  loadTemplateScripts as loadTemplateScriptsDefault,
  type WorkspaceTemplateScript,
} from "@surreal-ck/shared/workspace-template";
import {
  loadTemplatePackScripts as loadTemplatePackScriptsDefault,
  type TemplatePackScript,
} from "@surreal-ck/shared/template-packs";
import {
  LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION,
  selectContinuousEligibleMigrations,
  type WorkspaceQuotaMigrationState,
} from "@surreal-ck/shared/workspace-migration-manifest";
import { NATIVE_QUOTA_EXPECTED_CONTRACT } from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { toSurrealNone } from "../db/surreal-values";
import { materializeWorkspaceMigrationSql } from "../db/workspace-migration-execution";
import {
  SurrealNativeQuotaClient,
  type NativeQuotaClient,
} from "../db/native-quota/client";
import type { IdpTokenScopeAdapter } from "./idp-scope-adapter";
import { createIdpTokenScopeAdapter } from "./idp-scope-adapter";
import {
  runProvisioningQuotaSaga,
  type ExplicitResourceSource,
  type ProvisioningControlPlane,
  type ProvisioningPlanLookup,
  type ProvisioningStage,
  type ProvisioningWorkspaceRecord,
} from "./provisioning-saga";
import { evaluateWorkspaceScopeGate } from "./scope-gate";
import type { EntitlementBaseCandidate, EntitlementPlanRevision } from "../quota/entitlement-resolver";
import type { ProductQuotaRule, ResourceEntitlementRecord } from "@surreal-ck/shared/native-quota";
import type { CompiledQuotaPolicy } from "../quota/policy-compiler";

export type CreateWorkspaceClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type CreateWorkspaceSessionFactory = (
  database: string,
  namespace: string,
) => Promise<CreateWorkspaceClient>;

export type CreateWorkspaceInput = {
  subject: string;
  subjectToken: string;
  email: string;
  name: string;
  slug: string;
  /** Explicit resource source; Plus is never implicit. */
  resourceSource: ExplicitResourceSource;
};

export type CreateWorkspaceResult =
  | {
      kind: "created";
      slug: string;
      dbName: string;
      accessToken: string;
      expiresIn: number | null;
    }
  | {
      kind: "slug-conflict";
    }
  | {
      kind: "no-resource-source";
      code: string;
      message: string;
    }
  | {
      kind: "provisioning_error";
      code: string;
      message: string;
      slug: string;
      dbName: string;
    }
  | {
      kind: "scope-update-failed";
      slug: string;
      dbName: string;
    };

export interface WorkspaceCreator {
  createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult>;
}

export type CreateWorkspaceCreatorOptions = {
  getDbSession?: CreateWorkspaceSessionFactory;
  idpTokenScopeAdapter?: IdpTokenScopeAdapter;
  loadTemplateScripts?: () => Promise<WorkspaceTemplateScript[]>;
  loadTemplatePackScripts?: () => Promise<TemplatePackScript[]>;
  generateId?: () => string;
  namespace?: string;
  nativeQuotaClient?: NativeQuotaClient;
  engineCapabilities?: readonly string[];
  controlPlane?: ProvisioningControlPlane;
};

const SYSTEM_DATABASE = "_system";
const MAX_DB_NAME_ATTEMPTS = 5;

function defaultGenerateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function defaultGetDbSession(
  database: string,
  namespace: string,
): Promise<CreateWorkspaceClient> {
  return getRootDatabaseSession(database, namespace);
}

function rowCount(result: unknown): number {
  const rows = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(rows) ? rows.length : 0;
}

function firstRow(result: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(result) ? result[0] : undefined;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : null;
}

function makeWorkspaceDbName(id: string): string {
  const dbName = `ws_${id}`;
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error("generated workspace db name is invalid");
  }
  return dbName;
}

function asRecordId(value: unknown, fallback: string): StringRecordId {
  if (value instanceof StringRecordId) return value;
  if (typeof value === "string" && value.length > 0) {
    return new StringRecordId(value);
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    return new StringRecordId(String(value));
  }
  return new StringRecordId(fallback);
}

function provisioningWorkspaceFromRow(
  row: Record<string, unknown>,
  fallback: {
    dbName: string;
    slug: string;
    name: string;
    ownerSubject: string;
  },
): ProvisioningWorkspaceRecord {
  const status =
    row.status === "active" || row.status === "provisioning_error"
      ? row.status
      : "provisioning";
  const quotaMigrationState =
    row.quota_migration_state === "native_applied"
    || row.quota_migration_state === "native_verified"
    || row.quota_migration_state === "cleanup_done"
      ? row.quota_migration_state
      : "not_started";
  return {
    id: asRecordId(row.id, `workspace:${fallback.dbName}`),
    dbName: typeof row.db_name === "string" ? row.db_name : fallback.dbName,
    slug: typeof row.slug === "string" ? row.slug : fallback.slug,
    name: typeof row.name === "string" ? row.name : fallback.name,
    ownerSubject:
      typeof row.owner_subject === "string"
        ? row.owner_subject
        : fallback.ownerSubject,
    status,
    stage:
      typeof row.provisioning_stage === "string"
        ? (row.provisioning_stage as ProvisioningStage)
        : "reserved",
    quotaMigrationState,
    desiredEntitlement:
      row.desired_entitlement === undefined
        ? undefined
        : asRecordId(row.desired_entitlement, "resource_entitlement:unknown"),
    appliedEntitlement:
      row.applied_entitlement === undefined
        ? undefined
        : asRecordId(row.applied_entitlement, "resource_entitlement:unknown"),
    desiredQuotaProjection:
      row.desired_quota_projection === undefined
        ? undefined
        : asRecordId(row.desired_quota_projection, "quota_policy_projection:unknown"),
    appliedQuotaProjection:
      row.applied_quota_projection === undefined
        ? undefined
        : asRecordId(row.applied_quota_projection, "quota_policy_projection:unknown"),
    legacyCleanupAfter:
      row.legacy_cleanup_after instanceof DateTime
        ? row.legacy_cleanup_after
        : typeof row.legacy_cleanup_after === "string"
          ? new DateTime(row.legacy_cleanup_after)
          : undefined,
  };
}

function createSurrealControlPlane(
  systemDb: CreateWorkspaceClient,
  getDbSession: CreateWorkspaceSessionFactory,
  namespace: string,
): ProvisioningControlPlane {
  return {
    async reserveWorkspace(input) {
      const fallback = {
        dbName: input.dbName,
        slug: input.slug,
        name: input.name,
        ownerSubject: input.ownerSubject,
      };
      const loadExistingBySlug = async () =>
        firstRow(
          await systemDb.query(
            `
              SELECT *
              FROM workspace
              WHERE slug = $slug
              LIMIT 1;
            `,
            { slug: input.slug },
          ),
        );

      try {
        const existing = await loadExistingBySlug();
        if (existing) {
          if (
            existing.owner_subject === input.ownerSubject
            && (
              existing.status === "provisioning"
              || existing.status === "provisioning_error"
            )
          ) {
            return {
              kind: "reserved",
              workspace: provisioningWorkspaceFromRow(existing, fallback),
              resumed: true,
            };
          }
          return { kind: "slug-conflict" };
        }

        const dbNameResult = await systemDb.query(
          "SELECT VALUE id FROM workspace WHERE db_name = $dbName LIMIT 1;",
          { dbName: input.dbName },
        );
        if (rowCount(dbNameResult) > 0) return { kind: "db-name-conflict" };

        const result = await systemDb.query(
          `
            CREATE ONLY workspace CONTENT {
              db_name: $dbName,
              owner_subject: $subject,
              slug: $slug,
              name: $name,
              status: "provisioning",
              provisioning_stage: "reserved",
              quota_migration_state: "not_started"
            };
          `,
          {
            dbName: input.dbName,
            subject: input.ownerSubject,
            slug: input.slug,
            name: input.name,
          },
        );
        const row = firstRow(result);
        if (!row) {
          throw new Error("workspace reserve returned no row");
        }
        return {
          kind: "reserved",
          workspace: provisioningWorkspaceFromRow(row, fallback),
          resumed: false,
        };
      } catch (cause) {
        if (isSlugConflict(cause)) {
          const existing = await loadExistingBySlug();
          if (
            existing?.owner_subject === input.ownerSubject
            && (
              existing.status === "provisioning"
              || existing.status === "provisioning_error"
            )
          ) {
            return {
              kind: "reserved",
              workspace: provisioningWorkspaceFromRow(existing, fallback),
              resumed: true,
            };
          }
          return { kind: "slug-conflict" };
        }
        if (isDbNameConflict(cause)) return { kind: "db-name-conflict" };
        throw cause;
      }
    },

    async loadPlan(planKey) {
      const result = await systemDb.query(
        `
          SELECT id, active_revision
          FROM quota_plan
          WHERE plan_key = $planKey AND status = "active"
          LIMIT 1;
        `,
        { planKey },
      );
      const planRow = firstRow(result);
      if (!planRow?.active_revision) return null;

      const revisionResult = await systemDb.query(
        "SELECT * FROM ONLY $revision;",
        { revision: planRow.active_revision },
      );
      const revisionRow = firstRow(revisionResult);
      if (!revisionRow) return null;

      const planRevision: EntitlementPlanRevision = {
        id: asRecordId(revisionRow.id, `quota_plan_revision:${planKey}_v1`),
        template_kind: revisionRow.template_kind as EntitlementPlanRevision["template_kind"],
        rules: (revisionRow.rules ?? []) as ProductQuotaRule[],
      };
      const lookup: ProvisioningPlanLookup = {
        planRevision,
        rules: planRevision.rules,
      };
      return lookup;
    },

    async persistResourceSource(input) {
      const loadExistingCandidate = async (): Promise<EntitlementBaseCandidate | null> => {
        const itemResult = await systemDb.query(
          `
            SELECT * FROM quota_subscription_item
            WHERE workspace = $workspace
              AND status = "active"
            LIMIT 1;
          `,
          { workspace: input.workspace.id },
        );
        const itemRow = firstRow(itemResult);
        if (!itemRow) return null;
        if (
          asRecordId(
            itemRow.plan_revision,
            "quota_plan_revision:unknown",
          ).toString() !== input.planRevision.id.toString()
        ) {
          throw new Error(
            "existing provisioning source does not match requested plan revision",
          );
        }
        const subResult = await systemDb.query(
          "SELECT * FROM ONLY $subscription;",
          { subscription: itemRow.subscription },
        );
        const subRow = firstRow(subResult);
        if (!subRow) {
          throw new Error("provisioning subscription item has no subscription");
        }
        const asOptionalDateTime = (value: unknown): DateTime | undefined => {
          if (value instanceof DateTime) return value;
          if (typeof value === "string") return new DateTime(value);
          return undefined;
        };
        return {
          subscription: {
            id: asRecordId(subRow.id, "quota_subscription:unknown"),
            billing_account: asRecordId(
              subRow.billing_account,
              "billing_account:unknown",
            ),
            source:
              subRow.source as EntitlementBaseCandidate["subscription"]["source"],
            status:
              subRow.status as EntitlementBaseCandidate["subscription"]["status"],
            trial_start: asOptionalDateTime(subRow.trial_start),
            trial_end: asOptionalDateTime(subRow.trial_end),
          },
          item: {
            id: asRecordId(itemRow.id, "quota_subscription_item:unknown"),
            subscription: asRecordId(
              itemRow.subscription,
              "quota_subscription:unknown",
            ),
            workspace: input.workspace.id,
            plan_revision: input.planRevision.id,
            status: "active",
            effective_from:
              asOptionalDateTime(itemRow.effective_from) ?? DateTime.now(),
          },
          planRevision: input.planRevision,
        };
      };

      const existing = await loadExistingCandidate();
      if (existing) return existing;

      const accountKey = `personal:${input.ownerSubject}`;
      const subscriptionSource =
        input.sourceKind === "trial"
          ? "manual"
          : input.sourceKind === "paid"
            ? "provider"
            : input.sourceKind;

      await systemDb.query(
        `
          BEGIN TRANSACTION;

          LET $account = (
            SELECT * FROM billing_account WHERE account_key = $accountKey LIMIT 1
          )[0];
          LET $billing = IF $account = NONE {
            CREATE ONLY billing_account CONTENT {
              account_key: $accountKey,
              name: $accountName,
              kind: "personal",
              status: "active"
            }
          } ELSE {
            $account
          };

          INSERT INTO billing_account_member {
            billing_account: $billing.id,
            subject: $subject,
            role: "owner",
            status: "active"
          }
          ON DUPLICATE KEY UPDATE role = "owner", status = "active";

          LET $subscription = CREATE ONLY type::record(
            "quota_subscription",
            $subscriptionKey
          ) CONTENT {
            billing_account: $billing.id,
            source: $subscriptionSource,
            status: $subscriptionStatus,
            revision: 1,
            trial_start: $trialStart,
            trial_end: $trialEnd,
            correlation_id: $correlationId
          };

          CREATE ONLY type::record(
            "quota_subscription_item",
            $itemKey
          ) CONTENT {
            subscription: $subscription.id,
            workspace: $workspace,
            plan_revision: $planRevision,
            revision: 1,
            status: "active",
            effective_from: $effectiveAt,
            correlation_id: $correlationId,
            causation_id: $correlationId
          };

          COMMIT TRANSACTION;
        `,
        {
          accountKey,
          accountName: input.email || input.ownerSubject,
          subject: input.ownerSubject,
          subscriptionSource,
          subscriptionStatus: input.sourceKind === "trial" ? "trialing" : "active",
          trialStart:
            input.sourceKind === "trial" ? input.effectiveAt : undefined,
          trialEnd:
            input.sourceKind === "trial"
              ? DateTime.fromEpochNanoseconds(
                  input.effectiveAt.nanoseconds
                    + 14n * 24n * 60n * 60n * 1_000_000_000n,
                )
              : undefined,
          effectiveAt: input.effectiveAt,
          correlationId: input.correlationId,
          subscriptionKey: `provision_${input.workspace.dbName}`,
          itemKey: `provision_${input.workspace.dbName}`,
          workspace: input.workspace.id,
          planRevision: input.planRevision.id,
        },
      );

      const persisted = await loadExistingCandidate();
      if (!persisted) {
        throw new Error("failed to persist subscription item for provisioning");
      }
      return persisted;
    },

    async persistEntitlementAndProjection(input) {
      const entitlement = input.entitlement;
      const projection = input.projection;
      const existingResult = await systemDb.query(
        `
          SELECT id FROM ONLY $entitlementId;
          SELECT id, canonical_digest FROM ONLY $projectionId;
        `,
        {
          entitlementId: entitlement.id,
          projectionId: projection.id,
        },
      );
      const existingEntitlementRows = Array.isArray(existingResult)
        ? existingResult[0]
        : undefined;
      const existingProjectionRows = Array.isArray(existingResult)
        ? existingResult[1]
        : undefined;
      const existingEntitlement = Array.isArray(existingEntitlementRows)
        ? existingEntitlementRows[0]
        : existingEntitlementRows;
      const existingProjection = Array.isArray(existingProjectionRows)
        ? existingProjectionRows[0]
        : existingProjectionRows;
      if (existingEntitlement && existingProjection) {
        if (
          typeof existingProjection === "object"
          && existingProjection !== null
          && "canonical_digest" in existingProjection
          && existingProjection.canonical_digest
            !== projection.canonical_digest
        ) {
          throw new Error(
            "existing provisioning projection digest does not match",
          );
        }
        return {
          entitlementId: entitlement.id,
          projectionId: projection.id,
        };
      }
      if (existingEntitlement || existingProjection) {
        throw new Error(
          "partial provisioning entitlement/projection state requires operator repair",
        );
      }

      await systemDb.query(
        `
          BEGIN TRANSACTION;

            CREATE $entitlementId CONTENT $entitlement;
            CREATE $projectionId CONTENT $projection;
            CREATE entitlement_operation CONTENT {
              workspace: $workspace,
              operation_kind: "workspace_provisioning",
              outcome: "succeeded",
              entitlement: $entitlementId,
              projection: $projectionId,
              idempotency_key: $idempotencyKey,
              actor_kind: "system",
              actor_subject: $actor,
              effective_at: time::now(),
              correlation_id: $correlationId,
              causation_id: $causationId
            };
            LET $runtime = (
              SELECT VALUE id
              FROM workspace_quota_runtime
              WHERE workspace = $workspace
              LIMIT 1
            )[0];
            IF $runtime = NONE {
              CREATE workspace_quota_runtime CONTENT {
                workspace: $workspace,
                sync_state: "pending",
                service_mode: $serviceMode,
                quota_compliance: "unknown",
                capacity_state: "unknown",
                auto_reconcile: true,
                usage_trusted: false
              };
            } ELSE {
              UPDATE $runtime SET
                sync_state = "pending",
                service_mode = $serviceMode,
                auto_reconcile = true;
            };
            UPDATE $workspace SET
              desired_entitlement = $entitlementId,
              desired_quota_projection = $projectionId;

          COMMIT TRANSACTION;
        `,
        {
          entitlementId: entitlement.id,
          projectionId: projection.id,
          entitlement: {
            workspace: entitlement.workspace,
            revision: entitlement.revision,
            source_type: entitlement.source_type,
            subscription_item: entitlement.subscription_item,
            plan_revision: entitlement.plan_revision,
            override_revision: entitlement.override_revision,
            service_mode: entitlement.service_mode,
            rules: entitlement.rules,
            source_digest: entitlement.source_digest,
            effective_at: entitlement.effective_at,
            effective_until: entitlement.effective_until,
            correlation_id: entitlement.correlation_id,
            causation_id: entitlement.causation_id,
          },
          projection: {
            workspace: projection.workspace,
            entitlement: projection.entitlement,
            revision: projection.revision,
            compiler_version: projection.compiler_version,
            native_capability: projection.native_capability,
            native_contract_major: projection.native_contract_major,
            info_format_version: projection.info_format_version,
            rules: projection.rules,
            rule_labels: projection.rule_labels,
            canonical_digest: projection.canonical_digest,
            correlation_id: projection.correlation_id,
            causation_id: projection.causation_id,
          },
          workspace: input.workspace.id,
          idempotencyKey: `provision:${input.workspace.dbName}:${projection.id.toString()}`,
          actor: input.workspace.ownerSubject,
          correlationId: input.correlationId,
          causationId: entitlement.id.toString(),
          serviceMode: entitlement.service_mode,
        },
      );

      return {
        entitlementId: entitlement.id,
        projectionId: projection.id,
      };
    },

    async markStage(input) {
      await systemDb.query(
        `
          UPDATE $workspace SET
            provisioning_stage = $stage,
            status = IF $status = NONE THEN status ELSE $status END,
            quota_migration_state = IF $quotaMigrationState = NONE THEN quota_migration_state ELSE $quotaMigrationState END,
            provisioning_error_code = $errorCode,
            provisioning_error = $error,
            desired_entitlement = IF $desiredEntitlement = NONE THEN desired_entitlement ELSE $desiredEntitlement END,
            applied_entitlement = IF $appliedEntitlement = NONE THEN applied_entitlement ELSE $appliedEntitlement END,
            desired_quota_projection = IF $desiredQuotaProjection = NONE THEN desired_quota_projection ELSE $desiredQuotaProjection END,
            applied_quota_projection = IF $appliedQuotaProjection = NONE THEN applied_quota_projection ELSE $appliedQuotaProjection END,
            legacy_cleanup_after = IF $legacyCleanupAfter = NONE THEN legacy_cleanup_after ELSE $legacyCleanupAfter END,
            updated_at = time::now();
        `,
        {
          workspace: input.workspaceId,
          stage: input.stage,
          status: toSurrealNone(input.status),
          quotaMigrationState: toSurrealNone(input.quotaMigrationState),
          errorCode: toSurrealNone(input.errorCode),
          error: toSurrealNone(input.error),
          desiredEntitlement: toSurrealNone(input.desiredEntitlement),
          appliedEntitlement: toSurrealNone(input.appliedEntitlement),
          desiredQuotaProjection: toSurrealNone(input.desiredQuotaProjection),
          appliedQuotaProjection: toSurrealNone(input.appliedQuotaProjection),
          legacyCleanupAfter: toSurrealNone(input.legacyCleanupAfter),
        },
      );
    },

    async markAppliedFromNative(input) {
      await systemDb.query(
        `
          UPDATE $workspace SET
            applied_entitlement = $entitlementId,
            applied_quota_projection = $projectionId,
            desired_entitlement = $entitlementId,
            desired_quota_projection = $projectionId,
            updated_at = time::now();
          LET $runtime = (
            SELECT VALUE id
            FROM workspace_quota_runtime
            WHERE workspace = $workspace
            LIMIT 1
          )[0];
          IF $runtime = NONE {
            CREATE workspace_quota_runtime CONTENT {
              workspace: $workspace,
              sync_state: "in_sync",
              service_mode: "standard",
              quota_compliance: "compliant",
              capacity_state: "normal",
              auto_reconcile: true,
              last_native_audit_at: time::now(),
              native_observed_at: time::now(),
              native_observed_generation: $generation,
              native_observed_digest: $digest,
              ledger_state: $ledgerState,
              usage_trusted: $usageTrusted
            };
          } ELSE {
            UPDATE $runtime SET
              sync_state = "in_sync",
              service_mode = "standard",
              quota_compliance = "compliant",
              capacity_state = "normal",
              auto_reconcile = true,
              last_native_audit_at = time::now(),
              native_observed_at = time::now(),
              native_observed_generation = $generation,
              native_observed_digest = $digest,
              ledger_state = $ledgerState,
              usage_trusted = $usageTrusted;
          };
        `,
        {
          workspace: input.workspaceId,
          entitlementId: input.entitlementId,
          projectionId: input.projectionId,
          generation: toSurrealNone(input.generation),
          digest: input.digest,
          ledgerState: input.ledgerState,
          usageTrusted: input.usageTrusted,
        },
      );
    },

    async createPhysicalDatabase(dbName) {
      try {
        await systemDb.query(`DEFINE DATABASE ${dbName};`);
        return { kind: "created" };
      } catch (cause) {
        if (isDbNameConflict(cause)) return { kind: "db-name-conflict" };
        throw new Error(`workspace database create failed for ${dbName}`, { cause });
      }
    },

    async dropPhysicalDatabase(dbName) {
      await dropWorkspaceDatabase(systemDb, dbName);
    },

    async releaseReservation(workspace) {
      await systemDb.query(
        `
          DELETE user_workspace_index WHERE workspace = $workspace;
          DELETE $workspace;
        `,
        { workspace: workspace.id },
      );
    },
  };
}

export function createWorkspaceCreator(
  options: CreateWorkspaceCreatorOptions = {},
): WorkspaceCreator {
  const idpTokenScopeAdapter =
    options.idpTokenScopeAdapter ?? createIdpTokenScopeAdapter();
  const loadScripts =
    options.loadTemplateScripts
    ?? (() => loadTemplateScriptsDefault({ oidcJwksUrl: env.OIDC_JWKS_URL }));
  const loadPackScripts =
    options.loadTemplatePackScripts
    ?? (() =>
      loadTemplatePackScriptsDefault({ selectedPacks: env.WORKSPACE_TEMPLATE_PACKS }));
  const generateId = options.generateId ?? defaultGenerateId;
  const namespace = options.namespace ?? env.SURREAL_NS;
  const getDbSession = options.getDbSession ?? defaultGetDbSession;
  const engineCapabilities = options.engineCapabilities ?? [
    NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
  ];

  return {
    async createWorkspace(input) {
      if (!input.resourceSource?.planKey?.trim()) {
        return {
          kind: "no-resource-source",
          code: "workspace-resource-source-required",
          message:
            "explicit resource source (planKey) is required; Plus is never implicit",
        };
      }

      const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);

      for (let attempt = 0; attempt < MAX_DB_NAME_ATTEMPTS; attempt += 1) {
        const dbName = makeWorkspaceDbName(generateId());
        const result = await tryCreateWorkspace({
          systemDb,
          getDbSession,
          namespace,
          input,
          dbName,
          loadScripts,
          loadPackScripts,
          idpTokenScopeAdapter,
          nativeQuotaClient: options.nativeQuotaClient,
          engineCapabilities,
          controlPlane: options.controlPlane,
        });

        if (result.kind !== "db-name-conflict") {
          return result;
        }
      }

      throw new Error(
        `workspace db_name allocation failed after ${MAX_DB_NAME_ATTEMPTS} attempts`,
      );
    },
  };
}

type TryCreateWorkspaceInput = {
  systemDb: CreateWorkspaceClient;
  getDbSession: CreateWorkspaceSessionFactory;
  namespace: string;
  input: CreateWorkspaceInput;
  dbName: string;
  loadScripts: () => Promise<WorkspaceTemplateScript[]>;
  loadPackScripts: () => Promise<TemplatePackScript[]>;
  idpTokenScopeAdapter: IdpTokenScopeAdapter;
  nativeQuotaClient?: NativeQuotaClient;
  engineCapabilities: readonly string[];
  controlPlane?: ProvisioningControlPlane;
};

type TryCreateWorkspaceResult =
  | CreateWorkspaceResult
  | { kind: "db-name-conflict" };

async function tryCreateWorkspace({
  systemDb,
  getDbSession,
  namespace,
  input,
  dbName,
  loadScripts,
  loadPackScripts,
  idpTokenScopeAdapter,
  nativeQuotaClient,
  engineCapabilities,
  controlPlane: injectedControlPlane,
}: TryCreateWorkspaceInput): Promise<TryCreateWorkspaceResult> {
  const controlPlane =
    injectedControlPlane
    ?? createSurrealControlPlane(systemDb, getDbSession, namespace);

  const native =
    nativeQuotaClient
    ?? new SurrealNativeQuotaClient({
      async query<T = unknown>(
        sql: string,
        params?: Record<string, unknown>,
      ): Promise<T> {
        // Root client already scoped per session; native DDL uses ON DATABASE.
        return systemDb.query(sql, params) as Promise<T>;
      },
    });

  const sagaResult = await runProvisioningQuotaSaga(controlPlane, native, {
    subject: input.subject,
    email: input.email,
    name: input.name,
    slug: input.slug,
    dbName,
    resourceSource: input.resourceSource,
  });

  if (sagaResult.kind === "slug-conflict") return { kind: "slug-conflict" };
  if (sagaResult.kind === "db-name-conflict") return { kind: "db-name-conflict" };
  if (sagaResult.kind === "no-resource-source") {
    return {
      kind: "no-resource-source",
      code: sagaResult.code,
      message: sagaResult.message,
    };
  }
  if (sagaResult.kind === "provisioning_error") {
    return {
      kind: "provisioning_error",
      code: sagaResult.code,
      message: sagaResult.message,
      slug: input.slug,
      dbName: sagaResult.dbName,
    };
  }

  const workspace = sagaResult.workspace;
  const provisionedDbName = workspace.dbName;

  try {
    const workspaceDb = await getDbSession(provisionedDbName, namespace);
    const scripts = await loadScripts();
    const selection = selectContinuousEligibleMigrations(scripts, {
      engineCapabilities,
      quotaMigrationState: workspace.quotaMigrationState,
      // Greenfield databases have never served legacy traffic and therefore
      // do not need the existing-workspace rollback observation window.
      legacyCleanupEligible: true,
    });

    for (const script of selection.eligible) {
      await workspaceDb.query(
        await materializeWorkspaceMigrationSql(workspaceDb, script),
      );
      await workspaceDb.query(
        "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
        { version: script.version },
      );
    }

    const cleanupInTemplateSet = scripts.some(
      (script) => script.version === LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION,
    );
    const cleanupApplied = selection.eligible.some(
      (script) => script.version === LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION,
    );
    // Production templates include 021. When present, new workspaces must
    // finish cleanup under native_verified before active/scope.
    if (cleanupInTemplateSet && !cleanupApplied) {
      await controlPlane.markStage({
        workspaceId: workspace.id,
        stage: "policy_applied",
        status: "provisioning_error",
        errorCode: "workspace-legacy-cleanup-required",
        error:
          "new workspace must complete legacy quota cleanup before becoming active",
      }).catch(() => undefined);
      return {
        kind: "provisioning_error",
        code: "workspace-legacy-cleanup-required",
        message:
          "new workspace must complete legacy quota cleanup before becoming active",
        slug: input.slug,
        dbName: provisionedDbName,
      };
    }

    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "template_applied",
      quotaMigrationState: cleanupApplied ? "cleanup_done" : workspace.quotaMigrationState,
    });

    const packScripts = await loadPackScripts();
    for (const script of packScripts) {
      await workspaceDb.query(script.sql);
    }

    await workspaceDb.query(
      `INSERT INTO user {
         subject: $subject,
         email: $email,
         display_name: $displayName,
         kind: "human",
         is_admin: true,
         last_seen_at: time::now()
       }
       ON DUPLICATE KEY UPDATE is_admin = true, last_seen_at = time::now();`,
      {
        subject: input.subject,
        email: input.email,
        displayName: input.email || input.subject,
      },
    );

    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "owner_seeded",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "policy_applied",
      status: "provisioning_error",
      errorCode: "workspace-template-apply-failed",
      error: message,
    }).catch(() => undefined);
    // Keep physical db + control-plane tombstone for idempotent retry; do not
    // drop after native policy was applied (fail-closed retention).
    return {
      kind: "provisioning_error",
      code: "workspace-template-apply-failed",
      message,
      slug: input.slug,
      dbName: provisionedDbName,
    };
  }

  try {
    await createMembershipIndex(
      systemDb,
      input,
      provisionedDbName,
      workspace.id,
    );
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "index_ready",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "owner_seeded",
      status: "provisioning_error",
      errorCode: "workspace-index-failed",
      error: message,
    }).catch(() => undefined);
    if (isSlugConflict(cause)) return { kind: "slug-conflict" };
    if (isDbNameConflict(cause)) return { kind: "db-name-conflict" };
    return {
      kind: "provisioning_error",
      code: "workspace-index-failed",
      message,
      slug: input.slug,
      dbName: provisionedDbName,
    };
  }

  // Evaluate gate while still provisioning; only then flip to active.
  const gateSnapshot = await loadScopeGateSnapshot(systemDb, workspace.id, {
    statusOverride: "active",
  });
  const gate = evaluateWorkspaceScopeGate(gateSnapshot);
  if (!gate.ok) {
    await controlPlane.markStage({
      workspaceId: workspace.id,
      stage: "index_ready",
      status: "provisioning_error",
      errorCode: `workspace-scope-gate-${gate.reason}`,
      error: `scope gate denied before activate: ${gate.reason}`,
    }).catch(() => undefined);
    return {
      kind: "provisioning_error",
      code: `workspace-scope-gate-${gate.reason}`,
      message: `scope gate denied: ${gate.reason}`,
      slug: input.slug,
      dbName: provisionedDbName,
    };
  }

  await controlPlane.markStage({
    workspaceId: workspace.id,
    stage: "completed",
    status: "active",
    errorCode: null,
    error: null,
  });

  try {
    const scopeToken = await idpTokenScopeAdapter.updateUserScope({
      subjectToken: input.subjectToken,
      scope: { db: provisionedDbName, ac: "admin" },
    });
    return {
      kind: "created",
      slug: input.slug,
      dbName: provisionedDbName,
      accessToken: scopeToken.accessToken,
      expiresIn: scopeToken.expiresIn,
    };
  } catch {
    return {
      kind: "scope-update-failed",
      slug: input.slug,
      dbName: provisionedDbName,
    };
  }
}

async function createMembershipIndex(
  systemDb: CreateWorkspaceClient,
  input: CreateWorkspaceInput,
  dbName: string,
  workspaceId: StringRecordId,
): Promise<void> {
  await systemDb.query(
    `
      INSERT INTO user_workspace_index {
        subject: $subject,
        email: $email,
        workspace: $workspace,
        db_name: $dbName,
        role: $role,
        last_selected_at: time::now()
      }
      ON DUPLICATE KEY UPDATE role = $role, db_name = $dbName, last_selected_at = time::now();
    `,
    {
      dbName,
      subject: input.subject,
      email: input.email,
      workspace: workspaceId,
      role: "admin",
    },
  );
}

async function loadScopeGateSnapshot(
  systemDb: CreateWorkspaceClient,
  workspaceId: StringRecordId,
  options: { statusOverride?: string } = {},
) {
  const result = await systemDb.query(
    `
      SELECT status,
        desired_entitlement,
        applied_entitlement,
        desired_quota_projection,
        applied_quota_projection
      FROM ONLY $workspace;
      SELECT ledger_state, usage_trusted, last_native_audit_at
      FROM ONLY workspace_quota_runtime WHERE workspace = $workspace;
    `,
    { workspace: workspaceId },
  );
  const workspaceRow = firstRow(result);
  // second statement
  const runtimeRows = Array.isArray(result) ? result[1] : undefined;
  const runtimeRow = Array.isArray(runtimeRows)
    ? (runtimeRows[0] as Record<string, unknown> | undefined)
    : (runtimeRows as Record<string, unknown> | undefined);

  return {
    status: options.statusOverride
      ?? String(workspaceRow?.status ?? "provisioning"),
    desiredEntitlement: workspaceRow?.desired_entitlement as string | undefined,
    appliedEntitlement: workspaceRow?.applied_entitlement as string | undefined,
    desiredQuotaProjection: workspaceRow?.desired_quota_projection as
      | string
      | undefined,
    appliedQuotaProjection: workspaceRow?.applied_quota_projection as
      | string
      | undefined,
    ledgerState: runtimeRow?.ledger_state as string | undefined,
    usageTrusted: runtimeRow?.usage_trusted as boolean | undefined,
    lastNativeAuditAt: runtimeRow?.last_native_audit_at as string | undefined,
  };
}

function isSlugConflict(cause: unknown): boolean {
  const message = errorMessage(cause).toLowerCase();
  return (
    message.includes("workspace-slug-conflict")
    || message.includes("workspace_slug_unique")
  );
}

function isDbNameConflict(cause: unknown): boolean {
  const message = errorMessage(cause).toLowerCase();
  return (
    message.includes("workspace-db-conflict")
    || message.includes("workspace_db_name_unique")
    || (message.includes("database") && message.includes("already exists"))
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function dropWorkspaceDatabase(
  client: CreateWorkspaceClient,
  dbName: string,
): Promise<void> {
  try {
    await client.query(`REMOVE DATABASE IF EXISTS ${dbName};`);
  } catch {
    console.error(
      "[create-workspace]",
      `compensation drop failed for ${dbName}; manual cleanup required`,
    );
  }
}

// re-export for callers / tests
export type { ExplicitResourceSource, WorkspaceQuotaMigrationState };
// silence unused type imports in some TS configs
export type { ResourceEntitlementRecord, CompiledQuotaPolicy };
