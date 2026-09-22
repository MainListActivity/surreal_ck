import { buildLegacyQuotaCleanupSurql } from "@surreal-ck/shared";
import type { WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION } from "@surreal-ck/shared/workspace-migration-manifest";

export type WorkspaceMigrationExecutionClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

const RECORD_UPDATE_ACTIVITY_MIGRATION_VERSION = 29;

function stringRows(result: unknown): string[] {
  const rows = Array.isArray(result) ? result[0] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is string => typeof row === "string");
}

/**
 * Materialize migrations whose DDL needs runtime identifiers. All ordinary
 * migrations return their checked-in SQL unchanged.
 */
export async function materializeWorkspaceMigrationSql(
  db: WorkspaceMigrationExecutionClient,
  script: WorkspaceTemplateScript,
): Promise<string> {
  if (
    script.version !== LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION
    && script.version !== RECORD_UPDATE_ACTIVITY_MIGRATION_VERSION
  ) {
    return script.sql;
  }
  const tableNames = stringRows(
    await db.query("SELECT VALUE table_name FROM sheet;"),
  );
  if (script.version === LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION) {
    return buildLegacyQuotaCleanupSurql(tableNames);
  }
  const safeNames = [...new Set(tableNames)].sort();
  for (const tableName of safeNames) {
    if (!/^ent_[A-Za-z0-9_]+$/u.test(tableName)) {
      throw new Error(`invalid activity entity table name: ${tableName}`);
    }
  }
  return `BEGIN TRANSACTION;\n${safeNames.map((tableName) =>
    `DEFINE EVENT OVERWRITE record_activity ON TABLE ${tableName}
      WHEN $event = "CREATE" OR $event = "UPDATE" OR $event = "DELETE"
      THEN {
        LET $verb = IF $event = "DELETE" { "record.delete" } ELSE { "record.write" };
        LET $rec = IF $event = "DELETE" { $before } ELSE { $after };
        CREATE activity_event CONTENT { verb: $verb, target_kind: "record", target: $rec.id };
      };`
  ).join("\n")}\nCOMMIT TRANSACTION;`;
}
