import type { StringRecordId } from "surrealdb";

export type RecordQuotaGuardInput = {
  tableName: string;
  sheetId: StringRecordId;
};

const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_ENTITY_TABLE_NAME = /^ent_[a-z0-9_]{1,58}$/;
const SAFE_SHEET_RECORD_ID = /^sheet:[a-zA-Z0-9_]+$/;

/**
 * 动态实体表无法由静态 workspace migration 预先声明事件；新建数据表和已有
 * 数据表迁移都通过此公开构造器安装完全相同的记录配额闸门。
 */
export function buildRecordQuotaGuardSurql(input: RecordQuotaGuardInput): string {
  const sheetId = input.sheetId.toString();
  if (!SAFE_TABLE_NAME.test(input.tableName)) {
    throw new Error(`invalid entity table name: ${input.tableName}`);
  }
  if (!SAFE_SHEET_RECORD_ID.test(sheetId)) {
    throw new Error(`invalid sheet record id: ${sheetId}`);
  }

  // 021 清理后记账表被移除；表级引用缺失即抛错，用 record::exists 点查哨兵
  // （不命中表定义检查，缺失返回 false）让残留事件自行失效。
  return `DEFINE EVENT OVERWRITE resource_quota_guard ON TABLE ${input.tableName}
  WHEN $event = "CREATE" OR $event = "DELETE"
  THEN {
    IF record::exists(workspace_resource_quota:current) {
      IF $event = "CREATE" {
        LET $reserved = UPDATE sheet_resource_usage
          SET record_count += 1
          WHERE sheet = ${sheetId}
            AND record_count < workspace_resource_quota:current.plan.max_records_per_sheet
          RETURN AFTER;
        IF array::len($reserved) = 0 {
          THROW "quota-records-exceeded";
        };
      };
      IF $event = "DELETE" {
        UPDATE sheet_resource_usage
          SET record_count = math::max([0, record_count - 1])
          WHERE sheet = ${input.sheetId};
      };
    };
  };`;
}

/**
 * Build the deferred legacy cleanup as one transaction. DDL identifiers cannot
 * be parameterized reliably in REMOVE EVENT, so callers must first read the
 * authoritative sheet.table_name values and pass them through this strict
 * entity-table validator.
 */
export function buildLegacyQuotaCleanupSurql(
  tableNames: readonly string[],
): string {
  const uniqueTableNames = [...new Set(tableNames)].sort();
  for (const tableName of uniqueTableNames) {
    if (!SAFE_ENTITY_TABLE_NAME.test(tableName)) {
      throw new Error(
        `invalid legacy quota entity table name: ${tableName}`,
      );
    }
  }
  const dynamicEventRemoval = uniqueTableNames
    .map(
      (tableName) =>
        `  REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ${tableName};`,
    )
    .join("\n");

  return `BEGIN TRANSACTION;
${dynamicEventRemoval}
  REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE sheet;
  REMOVE TABLE IF EXISTS sheet_resource_usage;
  REMOVE TABLE IF EXISTS workspace_resource_quota;
  REMOVE TABLE IF EXISTS resource_quota_plan;
COMMIT TRANSACTION;`;
}

/**
 * 021 完成后新建的实体表仍可能带着旧实现安装的 resource_quota_guard（它们
 * 不在当时清理枚举里）。本清扫只移除残留事件，不动任何表或数据；仅在
 * quota_migration_state 为 native_verified/cleanup_done 的工作区执行。
 */
export function buildLegacyQuotaGuardResidualSurql(
  tableNames: readonly string[],
): string {
  const uniqueTableNames = [...new Set(tableNames)].sort();
  for (const tableName of uniqueTableNames) {
    if (!SAFE_ENTITY_TABLE_NAME.test(tableName)) {
      throw new Error(
        `invalid residual quota guard table name: ${tableName}`,
      );
    }
  }
  const removals = uniqueTableNames
    .map(
      (tableName) =>
        `  REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE ${tableName};`,
    )
    .join("\n");

  return `BEGIN TRANSACTION;
${removals}
  REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE sheet;
COMMIT TRANSACTION;`;
}
