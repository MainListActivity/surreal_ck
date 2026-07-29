import {
  loadTemplateScripts,
  type WorkspaceTemplateScript,
} from "@surreal-ck/shared/workspace-template";
import {
  LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION,
  selectContinuousEligibleMigrations,
  type WorkspaceQuotaMigrationState,
} from "@surreal-ck/shared/workspace-migration-manifest";
import { NATIVE_QUOTA_EXPECTED_CONTRACT } from "@surreal-ck/shared/native-quota";
import { env } from "../env";
import { dateTimeTimestamp } from "./surreal-values";
import { getRootConnection } from "./root-connection";
import { materializeWorkspaceMigrationSql } from "./workspace-migration-execution";

export type MigrationClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type MigrateAllWorkspacesOptions = {
  namespace?: string;
  loadScripts?: () => Promise<WorkspaceTemplateScript[]>;
  engineCapabilities?: readonly string[];
  now?: Date;
};

export type WorkspaceMigrationOutcome = {
  dbName: string;
  fromVersion: number;
  toVersion: number;
  blockedVersion?: number;
  blockedReason?: string;
};

export type MigrateAllWorkspacesResult = {
  total: number;
  migrated: WorkspaceMigrationOutcome[];
};

const SYSTEM_DATABASE = "_system";

type WorkspaceMigrationRow = {
  id?: unknown;
  db_name?: unknown;
  quota_migration_state?: unknown;
  legacy_cleanup_after?: unknown;
};

function readVersionResult(result: unknown): number {
  const firstResult = Array.isArray(result) ? result[0] : undefined;
  const firstRow = Array.isArray(firstResult) ? firstResult[0] : undefined;
  const version = typeof firstRow === "object" && firstRow !== null
    ? Reflect.get(firstRow, "version")
    : undefined;
  return typeof version === "number" ? version : 0;
}

function readWorkspaceRows(result: unknown): WorkspaceMigrationRow[] {
  const rows = Array.isArray(result) ? result[0] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows as WorkspaceMigrationRow[];
}

function readQuotaMigrationState(value: unknown): WorkspaceQuotaMigrationState {
  if (
    value === "not_started"
    || value === "native_applied"
    || value === "native_policy_active"
    || value === "native_verified"
    || value === "cleanup_done"
  ) {
    return value;
  }
  return "not_started";
}

async function readCurrentVersion(db: MigrationClient): Promise<number> {
  try {
    return readVersionResult(await db.query("SELECT version FROM schema_version:current;"));
  } catch {
    return 0;
  }
}

export async function migrateAllWorkspaces(
  db: MigrationClient = getRootConnection(),
  options: MigrateAllWorkspacesOptions = {},
): Promise<MigrateAllWorkspacesResult> {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const loadScripts = options.loadScripts
    ?? (() => loadTemplateScripts({ oidcJwksUrl: env.OIDC_JWKS_URL }));
  const engineCapabilities = options.engineCapabilities ?? [
    NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName,
  ];
  const nowMs = (options.now ?? new Date()).getTime();

  await db.use({ namespace, database: SYSTEM_DATABASE });
  const workspaceRows = readWorkspaceRows(
    await db.query(
      "SELECT id, db_name, quota_migration_state, legacy_cleanup_after FROM workspace;",
    ),
  );

  if (workspaceRows.length === 0) {
    return { total: 0, migrated: [] };
  }

  const scripts = await loadScripts();
  const migrated: WorkspaceMigrationOutcome[] = [];

  for (const row of workspaceRows) {
    const dbName = typeof row.db_name === "string" ? row.db_name : null;
    if (!dbName) continue;

    try {
      await db.use({ namespace, database: dbName });
      const fromVersion = await readCurrentVersion(db);
      const pending = scripts.filter((script) => script.version > fromVersion);
      const selection = selectContinuousEligibleMigrations(pending, {
        engineCapabilities,
        quotaMigrationState: readQuotaMigrationState(row.quota_migration_state),
        legacyCleanupEligible:
          dateTimeTimestamp(row.legacy_cleanup_after) > 0
          && dateTimeTimestamp(row.legacy_cleanup_after) <= nowMs,
      });

      for (const script of selection.eligible) {
        await db.query(await materializeWorkspaceMigrationSql(db, script));
        await db.query(
          "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
          { version: script.version },
        );

        // After successful legacy cleanup, advance control-plane state.
        if (script.version === LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION) {
          await db.use({ namespace, database: SYSTEM_DATABASE });
          await db.query(
            `
              UPDATE $workspace SET
                quota_migration_state = "cleanup_done",
                last_migration_version = $version,
                last_migration_error = NONE,
                last_migration_at = time::now(),
                updated_at = time::now();
            `,
            { workspace: row.id, version: script.version },
          );
          await db.use({ namespace, database: dbName });
        }
      }

      const toVersion = selection.eligible.at(-1)?.version ?? fromVersion;
      await db.use({ namespace, database: SYSTEM_DATABASE });
      await db.query(
        `
          UPDATE $workspace SET
            last_migration_version = $version,
            last_migration_error = NONE,
            last_migration_at = time::now(),
            updated_at = time::now();
        `,
        {
          workspace: row.id,
          version: selection.eligible.length > 0 ? toVersion : fromVersion,
        },
      );

      if (selection.eligible.length > 0 || selection.blocked) {
        migrated.push({
          dbName,
          fromVersion,
          toVersion: selection.eligible.length > 0 ? toVersion : fromVersion,
          blockedVersion: selection.blocked?.version,
          blockedReason: selection.blocked?.eligibility.reason,
        });
        if (selection.eligible.length > 0) {
          console.info("[migration]", `${dbName}: ${fromVersion} → ${toVersion}`);
        }
        if (selection.blocked) {
          console.info(
            "[migration]",
            `${dbName}: blocked at v${selection.blocked.version} (${selection.blocked.eligibility.reason}); version not advanced past gate`,
          );
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        await db.use({ namespace, database: SYSTEM_DATABASE });
        await db.query(
          `
            UPDATE $workspace SET
              last_migration_error = $error,
              last_migration_at = time::now(),
              updated_at = time::now();
          `,
          { workspace: row.id, error: message },
        );
      } catch {
        // ignore secondary writeback failure
      }

      const progress = `${migrated.length}/${workspaceRows.length}`;
      console.error("[migration]", `${dbName} failed after ${progress} migrated; aborting startup`);
      throw new Error(
        `workspace migration failed on ${dbName} (${progress} migrated before failure)`,
        { cause },
      );
    }
  }

  return { total: workspaceRows.length, migrated };
}

// retained for tests that import the private helper name path via re-export
export type { WorkspaceQuotaMigrationState };
