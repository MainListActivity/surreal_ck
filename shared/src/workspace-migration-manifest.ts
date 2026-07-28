import { NATIVE_QUOTA_EXPECTED_CONTRACT } from "./native-quota/compatibility";

/**
 * Workspace template migrations are discovered by filename version. Extra
 * eligibility gates live here so capability-aware runners can skip or block
 * without partial execution or silent version advancement.
 */
export type WorkspaceQuotaMigrationState =
  | "not_started"
  | "native_applied"
  | "native_verified"
  | "cleanup_done";

export type WorkspaceMigrationRequirement = Readonly<{
  /** Exact engine capability name required before SQL may run. */
  requires_engine_capability?: string;
  /**
   * Workspace must be in one of these quota migration states.
   * When absent, any state is eligible.
   */
  requires_quota_migration_state?: readonly WorkspaceQuotaMigrationState[];
  /**
   * Existing workspaces may remove rollback protection only after the
   * persisted stability window has elapsed. Greenfield provisioning sets this
   * true explicitly because no legacy traffic or data ever relied on 020.
   */
  requires_legacy_cleanup_eligible?: boolean;
}>;

/** Version of the deferred legacy event/table cleanup migration. */
export const LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION = 21;

/** Gated migrations only. Ungated versions omit an entry. */
export const WORKSPACE_MIGRATION_REQUIREMENTS: Readonly<
  Record<number, WorkspaceMigrationRequirement>
> = Object.freeze({
  // Legacy event cleanup: never before native policy is INFO-verified.
  [LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION]: Object.freeze({
    requires_engine_capability: NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
    requires_quota_migration_state: Object.freeze([
      "native_verified",
      "cleanup_done",
    ] as const),
    requires_legacy_cleanup_eligible: true,
  }),
});

export type WorkspaceMigrationEligibility =
  | { kind: "eligible" }
  | {
      kind: "blocked";
      reason:
        | "missing_engine_capability"
        | "quota_migration_state"
        | "legacy_cleanup_window"
        | "unknown_requirement";
      details: Readonly<Record<string, unknown>>;
    };

export type WorkspaceMigrationContext = Readonly<{
  engineCapabilities: ReadonlySet<string> | readonly string[];
  quotaMigrationState: WorkspaceQuotaMigrationState;
  legacyCleanupEligible: boolean;
}>;

function asCapabilitySet(
  capabilities: WorkspaceMigrationContext["engineCapabilities"],
): ReadonlySet<string> {
  return capabilities instanceof Set ? capabilities : new Set(capabilities);
}

/**
 * Decide whether one migration version may execute. Blocked migrations must not
 * run SQL and must not advance schema_version.
 */
export function evaluateWorkspaceMigrationEligibility(
  version: number,
  context: WorkspaceMigrationContext,
  requirements: Readonly<
    Record<number, WorkspaceMigrationRequirement>
  > = WORKSPACE_MIGRATION_REQUIREMENTS,
): WorkspaceMigrationEligibility {
  const requirement = requirements[version];
  if (!requirement) return { kind: "eligible" };

  const capabilities = asCapabilitySet(context.engineCapabilities);

  if (
    requirement.requires_engine_capability
    && !capabilities.has(requirement.requires_engine_capability)
  ) {
    return {
      kind: "blocked",
      reason: "missing_engine_capability",
      details: Object.freeze({
        version,
        required: requirement.requires_engine_capability,
      }),
    };
  }

  if (requirement.requires_quota_migration_state) {
    const allowed = requirement.requires_quota_migration_state;
    if (!allowed.includes(context.quotaMigrationState)) {
      return {
        kind: "blocked",
        reason: "quota_migration_state",
        details: Object.freeze({
          version,
          required: allowed,
          actual: context.quotaMigrationState,
        }),
      };
    }
  }

  if (
    requirement.requires_legacy_cleanup_eligible
    && context.quotaMigrationState !== "cleanup_done"
    && !context.legacyCleanupEligible
  ) {
    return {
      kind: "blocked",
      reason: "legacy_cleanup_window",
      details: Object.freeze({ version }),
    };
  }

  return { kind: "eligible" };
}

/**
 * Continuous pending set: stop at the first blocked migration so later versions
 * never leapfrog a gated predecessor.
 */
export function selectContinuousEligibleMigrations<
  T extends { version: number },
>(
  pending: readonly T[],
  context: WorkspaceMigrationContext,
  requirements: Readonly<
    Record<number, WorkspaceMigrationRequirement>
  > = WORKSPACE_MIGRATION_REQUIREMENTS,
): Readonly<{
  eligible: readonly T[];
  blocked?: Readonly<{
    version: number;
    eligibility: Extract<WorkspaceMigrationEligibility, { kind: "blocked" }>;
  }>;
}> {
  const eligible: T[] = [];
  for (const script of pending) {
    const eligibility = evaluateWorkspaceMigrationEligibility(
      script.version,
      context,
      requirements,
    );
    if (eligibility.kind === "blocked") {
      return Object.freeze({
        eligible: Object.freeze(eligible),
        blocked: Object.freeze({ version: script.version, eligibility }),
      });
    }
    eligible.push(script);
  }
  return Object.freeze({ eligible: Object.freeze(eligible) });
}
