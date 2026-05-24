-- Grid 业务表：workbook / sheet / dashboard_page。
-- 每个 workspace 是独立 SurrealDB database，跨 workspace 隔离靠 db 边界——
-- 这些表不带 workspace 字段，PERMISSIONS 只表达「本 workspace 内的角色」。
-- DDL（建表/改列）由 access 类型卡死：admin(JWT) 才有，participant/employee(RECORD) 只有 DML。

DEFINE TABLE IF NOT EXISTS workbook SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS name ON TABLE workbook TYPE string;
DEFINE FIELD IF NOT EXISTS template_key ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_opened_sheet ON TABLE workbook TYPE option<record<sheet>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_name ON TABLE workbook COLUMNS name;

DEFINE TABLE IF NOT EXISTS sheet SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE sheet TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS label ON TABLE sheet TYPE string;
-- 每个 sheet 背后是一张真实业务数据表，table_name 指向它；searchRecord 据此动态查询。
DEFINE FIELD IF NOT EXISTS table_name ON TABLE sheet TYPE string;
DEFINE FIELD IF NOT EXISTS column_defs ON TABLE sheet TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE sheet TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE sheet TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS sheet_workbook ON TABLE sheet COLUMNS workbook;
DEFINE INDEX IF NOT EXISTS sheet_table_name_unique ON TABLE sheet COLUMNS table_name UNIQUE;

DEFINE TABLE IF NOT EXISTS dashboard_page SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE dashboard_page TYPE option<record<workbook>>;
DEFINE FIELD IF NOT EXISTS title ON TABLE dashboard_page TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON TABLE dashboard_page TYPE string;
DEFINE FIELD IF NOT EXISTS description ON TABLE dashboard_page TYPE option<string>;
DEFINE FIELD IF NOT EXISTS widgets ON TABLE dashboard_page TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE dashboard_page TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE dashboard_page TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS dashboard_page_slug_unique ON TABLE dashboard_page COLUMNS workbook, slug UNIQUE;
DEFINE INDEX IF NOT EXISTS dashboard_page_title ON TABLE dashboard_page COLUMNS title;
