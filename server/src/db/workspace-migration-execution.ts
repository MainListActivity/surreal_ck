import {
  buildEntityTableMemberPermissionsAlter,
  buildLegacyQuotaCleanupSurql,
  buildLegacyQuotaGuardResidualSurql,
  ENTITY_TABLE_MEMBER_PERMISSION_WHERE,
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
const ENTITY_MEMBER_PERMISSIONS_MIGRATION_VERSION = 43;

function stringRows(result: unknown): string[] {
  const rows = Array.isArray(result) ? result[0] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is string => typeof row === "string");
}

/** `INFO FOR DB` 的 `tables` 键是「表名 → DEFINE 定义文本」映射。 */
function readInfoTableDefinitions(result: unknown): Record<string, string> {
  const info = Array.isArray(result) ? result[0] : undefined;
  const tables = typeof info === "object" && info !== null
    ? Reflect.get(info, "tables")
    : undefined;
  if (typeof tables !== "object" || tables === null) return {};
  const definitions: Record<string, string> = {};
  for (const [name, definition] of Object.entries(tables)) {
    if (typeof definition === "string") definitions[name] = definition;
  }
  return definitions;
}

/**
 * 定义文本里是否存在「自定义」PERMISSIONS：无子句（动态实体表缺省形态）与
 * 显式 PERMISSIONS NONE（登记在册的业务表上等于同一缺陷形态）都需要回填；
 * 带 FOR 子句或 FULL 的既有策略视为自定义，保留原样交由经理裁定，不在
 * 迁移里扩大也不收窄他人授权面。
 */
function hasCustomTablePermissions(definition: string): boolean {
  const index = definition.indexOf("PERMISSIONS");
  if (index === -1) return false;
  return !/^PERMISSIONS\s+NONE\s*$/i.test(definition.slice(index).trim());
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
    && script.version !== ENTITY_MEMBER_PERMISSIONS_MIGRATION_VERSION
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
  if (script.version === ENTITY_MEMBER_PERMISSIONS_MIGRATION_VERSION) {
    const tableDefinitions = readInfoTableDefinitions(
      await db.query("INFO FOR DB;"),
    );
    const alters: string[] = [];
    const preservedCustomPermissions: string[] = [];
    const missingTables: string[] = [];
    for (const tableName of [...tableNames].sort()) {
      const definition = tableDefinitions[tableName];
      if (definition === undefined) {
        missingTables.push(tableName);
        continue;
      }
      // 已带标准谓词的表是「已修复」，静默跳过使重跑为纯 no-op。
      if (definition.includes(ENTITY_TABLE_MEMBER_PERMISSION_WHERE)) {
        continue;
      }
      if (hasCustomTablePermissions(definition)) {
        preservedCustomPermissions.push(tableName);
        continue;
      }
      alters.push(buildEntityTableMemberPermissionsAlter(tableName));
    }
    if (preservedCustomPermissions.length > 0) {
      console.warn(
        "[migration]",
        `entity member permissions: preserved custom PERMISSIONS on ${preservedCustomPermissions.join(", ")}`,
      );
    }
    if (missingTables.length > 0) {
      console.warn(
        "[migration]",
        `entity member permissions: registered sheet tables missing: ${missingTables.join(", ")}`,
      );
    }
    if (alters.length === 0) {
      return `RETURN "entity-member-permissions-nothing-to-apply";`;
    }
    return `BEGIN TRANSACTION;\n${alters.join("\n")}\nCOMMIT TRANSACTION;`;
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
