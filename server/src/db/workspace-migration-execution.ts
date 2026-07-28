import { buildLegacyQuotaCleanupSurql } from "@surreal-ck/shared";
import type { WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION } from "@surreal-ck/shared/workspace-migration-manifest";

export type WorkspaceMigrationExecutionClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

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
  if (script.version !== LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION) {
    return script.sql;
  }
  const tableNames = stringRows(
    await db.query("SELECT VALUE table_name FROM sheet;"),
  );
  return buildLegacyQuotaCleanupSurql(tableNames);
}
