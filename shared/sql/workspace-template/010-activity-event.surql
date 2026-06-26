-- activity_event：首页「动态」的真实数据来源。
--
-- 动态事件由 SurrealDB 引擎层 DEFINE EVENT 自动写入——前端零埋点：用户对业务表
-- 做写操作时 event 触发并 CREATE activity_event。本文件负责表本身 + workbook /
-- sheet / dashboard_page 三张静态业务表上的 event；记录级实体表（ent_<wbKey>_main）
-- 是动态建的，其 record_activity event 在建表事务里一并定义（HR-15）。
--
-- 归属 workspace database：跨 workspace 隔离靠 db 边界，不带 workspace 字段，
-- PERMISSIONS 只表达本 workspace 内角色。归因走 fn::current_user()（009）——
-- admin(JWT) 会话 $auth 为 NONE 时按 $token.sub 反查，participant/employee(RECORD)
-- 直接返回 $auth。event THEN 块在写操作的会话上下文里执行，fn::current_user()
-- 解析到的就是真实触发者。

DEFINE TABLE IF NOT EXISTS activity_event SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth != NONE,
    FOR update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS actor ON TABLE activity_event TYPE option<record<user>> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS verb ON TABLE activity_event TYPE string
  ASSERT $value INSIDE [
    "workbook.create", "workbook.rename", "workbook.delete",
    "sheet.create", "sheet.delete",
    "dashboard.create", "dashboard.delete",
    "field.define", "field.remove",
    "record.write", "record.delete",
    "ai.write", "resource.save"
  ];
-- target_kind / target_name：动态文案的宾语（"工作簿「X」"），由 event 从 $after 取。
DEFINE FIELD IF NOT EXISTS target_kind ON TABLE activity_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS target_name ON TABLE activity_event TYPE option<string>;
-- target：可选指回源记录，便于点击跳转；不强约束类型（跨多张表）。
DEFINE FIELD IF NOT EXISTS target ON TABLE activity_event TYPE option<record>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE activity_event TYPE datetime VALUE time::now() READONLY;
-- 列表按时间倒序 + HR-17 按天聚合都吃这条索引。
DEFINE INDEX IF NOT EXISTS activity_event_created ON TABLE activity_event COLUMNS created_at;

-- ---- 静态业务表 event：写入即落动态 ----
-- THEN 块只在用户写操作时触发（不含 root 维护连接，那条无 $auth 也无 $token）。
-- $event = "CREATE" / "UPDATE" / "DELETE"；CREATE/DELETE 用 $after/$before 取名字。

DEFINE EVENT OVERWRITE workbook_activity ON TABLE workbook
  WHEN $event = "CREATE" OR $event = "UPDATE" OR $event = "DELETE"
  THEN {
    LET $verb = IF $event = "CREATE" { "workbook.create" }
      ELSE IF $event = "DELETE" { "workbook.delete" }
      ELSE { "workbook.rename" };
    LET $rec = IF $event = "DELETE" { $before } ELSE { $after };
    CREATE activity_event CONTENT {
      verb: $verb,
      target_kind: "workbook",
      target_name: $rec.name,
      target: $rec.id,
    };
  };

DEFINE EVENT OVERWRITE sheet_activity ON TABLE sheet
  WHEN $event = "CREATE" OR $event = "DELETE"
  THEN {
    LET $verb = IF $event = "CREATE" { "sheet.create" } ELSE { "sheet.delete" };
    LET $rec = IF $event = "DELETE" { $before } ELSE { $after };
    CREATE activity_event CONTENT {
      verb: $verb,
      target_kind: "sheet",
      target_name: $rec.label,
      target: $rec.id,
    };
  };

DEFINE EVENT OVERWRITE dashboard_page_activity ON TABLE dashboard_page
  WHEN $event = "CREATE" OR $event = "DELETE"
  THEN {
    LET $verb = IF $event = "CREATE" { "dashboard.create" } ELSE { "dashboard.delete" };
    LET $rec = IF $event = "DELETE" { $before } ELSE { $after };
    CREATE activity_event CONTENT {
      verb: $verb,
      target_kind: "dashboard",
      target_name: $rec.title,
      target: $rec.id,
    };
  };
