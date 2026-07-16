-- 资源与任意动态业务记录之间的业务关系。
-- 关系方向固定为 resource_item -> resource_record_link -> 业务记录，
-- workspace 隔离由 database 边界保证。
DEFINE TABLE IF NOT EXISTS resource_record_link TYPE RELATION SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE
    FOR create WHERE $auth != NONE
    FOR update NONE
    FOR delete WHERE
      created_by = $auth
      OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS in ON TABLE resource_record_link TYPE record<resource_item>
  READONLY;
DEFINE FIELD IF NOT EXISTS out ON TABLE resource_record_link TYPE record
  READONLY;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE resource_record_link TYPE record<user>
  DEFAULT $auth
  READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE resource_record_link TYPE datetime
  VALUE time::now()
  READONLY;
DEFINE INDEX IF NOT EXISTS resource_record_link_unique ON TABLE resource_record_link COLUMNS in, out
  UNIQUE;
DEFINE INDEX IF NOT EXISTS resource_record_link_created_by ON TABLE resource_record_link COLUMNS created_by;

-- 资源主记录由管理员删除时同步清理出边；解除关联本身不会删除任何端点。
DEFINE EVENT OVERWRITE resource_record_link_cleanup ON TABLE resource_item
  WHEN $event = "DELETE"
  THEN {
    DELETE resource_record_link WHERE in = $before.id;
  };
