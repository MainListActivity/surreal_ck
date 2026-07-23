-- 工作区资源配额。每个 workspace database 就是一个工作区，因此
-- workspace_resource_quota:current 是该工作区与套餐的唯一绑定。
-- Plus / Pro / Max 为可手工修改的数据；事件每次都解引用当前套餐，
-- 修改套餐或套餐额度后无需重建事件即可立即生效。

DEFINE TABLE IF NOT EXISTS resource_quota_plan SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS key ON TABLE resource_quota_plan TYPE string
  ASSERT $value INSIDE ["plus", "pro", "max"];
DEFINE FIELD IF NOT EXISTS max_sheets ON TABLE resource_quota_plan TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS max_fields_per_sheet ON TABLE resource_quota_plan TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS max_records_per_sheet ON TABLE resource_quota_plan TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE resource_quota_plan TYPE datetime
  VALUE time::now()
  READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE resource_quota_plan TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS resource_quota_plan_key_unique ON TABLE resource_quota_plan COLUMNS key
  UNIQUE;

INSERT INTO resource_quota_plan [
  {
    id: resource_quota_plan:plus,
    key: "plus",
    max_sheets: 1,
    max_fields_per_sheet: 3,
    max_records_per_sheet: 2,
  },
  {
    id: resource_quota_plan:pro,
    key: "pro",
    max_sheets: 2,
    max_fields_per_sheet: 6,
    max_records_per_sheet: 4,
  },
  {
    id: resource_quota_plan:max,
    key: "max",
    max_sheets: 3,
    max_fields_per_sheet: 9,
    max_records_per_sheet: 6,
  },
]
ON DUPLICATE KEY UPDATE updated_at = updated_at;

DEFINE TABLE IF NOT EXISTS workspace_resource_quota SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS plan ON TABLE workspace_resource_quota TYPE record<resource_quota_plan>;
DEFINE FIELD IF NOT EXISTS sheet_count ON TABLE workspace_resource_quota TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_resource_quota TYPE datetime
  VALUE time::now()
  READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workspace_resource_quota TYPE datetime
  VALUE time::now();

INSERT INTO workspace_resource_quota {
  id: workspace_resource_quota:current,
  plan: resource_quota_plan:plus,
  sheet_count: array::len(
    (
      SELECT VALUE id
      FROM sheet
    )
  ),
}
ON DUPLICATE KEY UPDATE sheet_count = sheet_count;

DEFINE TABLE IF NOT EXISTS sheet_resource_usage SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS sheet ON TABLE sheet_resource_usage TYPE record<sheet>;
DEFINE FIELD IF NOT EXISTS record_count ON TABLE sheet_resource_usage TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE sheet_resource_usage TYPE datetime
  VALUE time::now()
  READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE sheet_resource_usage TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS sheet_resource_usage_sheet_unique ON TABLE sheet_resource_usage COLUMNS sheet
  UNIQUE;

DEFINE EVENT OVERWRITE resource_quota_guard ON TABLE sheet
  WHEN $event = "CREATE"
  OR $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    IF $event = "CREATE" {
      IF array::len($after.column_defs) > workspace_resource_quota:current.plan.max_fields_per_sheet {
        THROW "quota-fields-exceeded";
      };
      LET $reserved = UPDATE ONLY workspace_resource_quota:current SET
        sheet_count += 1
      WHERE sheet_count < plan.max_sheets
      RETURN AFTER;
      IF $reserved = NONE {
        THROW "quota-sheets-exceeded";
      };
      INSERT INTO sheet_resource_usage {
        sheet: $after.id,
        record_count: 0,
      }
      ON DUPLICATE KEY UPDATE sheet = $after.id;
    };
    IF $event = "UPDATE"
    AND array::len($after.column_defs) > array::len($before.column_defs)
    AND array::len($after.column_defs) > workspace_resource_quota:current.plan.max_fields_per_sheet {
      THROW "quota-fields-exceeded";
    };
    IF $event = "DELETE" {
      UPDATE ONLY workspace_resource_quota:current SET
        sheet_count = math::max([0, sheet_count - 1]);
      DELETE sheet_resource_usage WHERE sheet = $before.id;
    };
  };
