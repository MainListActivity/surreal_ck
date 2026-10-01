import {
  buildLegacyQuotaCleanupSurql,
  buildLegacyQuotaGuardResidualSurql,
  isSafeSheetTableName,
} from "@surreal-ck/shared";
import type { WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import {
  LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION,
  LEGACY_QUOTA_GUARD_RESIDUAL_MIGRATION_VERSION,
} from "@surreal-ck/shared/workspace-migration-manifest";

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
    && script.version !== LEGACY_QUOTA_GUARD_RESIDUAL_MIGRATION_VERSION
    && script.version !== RECORD_UPDATE_ACTIVITY_MIGRATION_VERSION
  ) {
    return script.sql;
  }
  const rawTableNames = stringRows(
    await db.query("SELECT VALUE table_name FROM sheet;"),
  );
  // sheet.table_name 是持久化数据而非纯 ent_* 命名（如 qa_ver03_materials）；
  // 无法安全拼进 DDL 的名字跳过并告警，不能让单行异常数据中止启动迁移。
  const tableNames = [...new Set(rawTableNames)].filter((tableName) => {
    if (isSafeSheetTableName(tableName)) return true;
    console.warn(
      "[migration]",
      `skipped unsafe sheet.table_name: ${JSON.stringify(tableName)}`,
    );
    return false;
  });
  if (script.version === LEGACY_QUOTA_CLEANUP_MIGRATION_VERSION) {
    return buildLegacyQuotaCleanupSurql(tableNames);
  }
  if (script.version === LEGACY_QUOTA_GUARD_RESIDUAL_MIGRATION_VERSION) {
    return buildLegacyQuotaGuardResidualSurql(tableNames);
  }
  const safeNames = tableNames.sort();
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
