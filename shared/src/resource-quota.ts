import type { StringRecordId } from "surrealdb";

export const RESOURCE_QUOTA_PLANS = {
  plus: {
    maxSheets: 1,
    maxFieldsPerSheet: 3,
    maxRecordsPerSheet: 2,
  },
  pro: {
    maxSheets: 2,
    maxFieldsPerSheet: 6,
    maxRecordsPerSheet: 4,
  },
  max: {
    maxSheets: 3,
    maxFieldsPerSheet: 9,
    maxRecordsPerSheet: 6,
  },
} as const;

export type ResourceQuotaPlanKey = keyof typeof RESOURCE_QUOTA_PLANS;

export type RecordQuotaGuardInput = {
  tableName: string;
  sheetId: StringRecordId;
};

const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
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

  return `DEFINE EVENT OVERWRITE resource_quota_guard ON TABLE ${input.tableName}
  WHEN $event = "CREATE" OR $event = "DELETE"
  THEN {
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
  };`;
}
