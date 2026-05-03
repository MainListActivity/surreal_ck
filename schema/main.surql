OPTION IMPORT;

DEFINE NAMESPACE IF NOT EXISTS main;
USE NS main DB docs;

-- ═══════════════════════════════════════════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════════════════════════════════════════

-- app_user 在首次 JWT 登录时自动创建（见 DEFINE ACCESS）。
-- 用户只能读取和更新自己的记录，不允许自行创建。
DEFINE TABLE IF NOT EXISTS app_user SCHEMAFULL
  PERMISSIONS
    FOR select, update WHERE id = $auth,
    FOR create, delete NONE;
DEFINE FIELD IF NOT EXISTS subject      ON TABLE app_user TYPE string;
DEFINE FIELD IF NOT EXISTS email        ON TABLE app_user TYPE option<string>
  ASSERT $value = NONE OR string::is_email($value);
DEFINE FIELD IF NOT EXISTS name         ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS avatar       ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at   ON TABLE app_user TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at   ON TABLE app_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS app_user_subject_unique ON TABLE app_user COLUMNS subject UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- WORKSPACE
-- 工作空间是顶层租户边界。一个律所 / 团队 = 一个 workspace。
--
-- 所有权用字段表示：workspace.owner TYPE record<app_user>
-- 成员关系用边表示：workspace ->has_workspace_member-> app_user
--
-- 权限路径：
--   owner:  owner = $auth
--   member: id IN $auth<-has_workspace_member<-workspace
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      owner = $auth
      OR id IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update WHERE owner = $auth,
    FOR delete WHERE owner = $auth;
DEFINE FIELD IF NOT EXISTS owner      ON TABLE workspace TYPE record<app_user>;
DEFINE FIELD IF NOT EXISTS name       ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS slug       ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_slug_unique ON TABLE workspace COLUMNS slug UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_owner       ON TABLE workspace COLUMNS owner;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PENDING_WORKSPACE_MEMBER
-- 邀请态：管理员向某个邮箱发出邀请后创建，用户接受邀请后删除。
-- 接受后在 has_workspace_member 边中写入正式成员关系。
--
-- 为什么是普通表而非边：
--   被邀请的用户在接受前可能尚未注册，不存在 app_user 记录，
--   无法作为 RELATION 的 out 端点。邀请本身是一个待处理事件，
--   用普通表表达其独立生命周期（可撤销、可重发、可过期）。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS pending_workspace_member SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR email = $auth.email,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE pending_workspace_member TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS email      ON TABLE pending_workspace_member TYPE string
  ASSERT string::is_email($value);
DEFINE FIELD IF NOT EXISTS role       ON TABLE pending_workspace_member TYPE string
  ASSERT $value INSIDE ["admin", "editor", "viewer"];
DEFINE FIELD IF NOT EXISTS invited_at ON TABLE pending_workspace_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS pending_member_ws_email_unique
  ON TABLE pending_workspace_member COLUMNS workspace, email UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HAS_WORKSPACE_MEMBER（边）
-- 正式成员关系：workspace -> app_user
--
-- 为什么是边：
--   M:N（一个 user 可加入多个 workspace，一个 workspace 有多个 member），
--   边本身携带属性（role、joined_at），双向遍历都有意义，
--   且"加入"这一事件在业务上有语义。
--
-- 遍历：
--   workspace 的所有成员：workspace->has_workspace_member->app_user
--   user 所在的 workspace：$auth<-has_workspace_member<-workspace
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS has_workspace_member TYPE RELATION IN workspace OUT app_user SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in.owner = $auth
      OR out = $auth,
    FOR create, update, delete WHERE
      in.owner = $auth;
DEFINE FIELD IF NOT EXISTS role      ON TABLE has_workspace_member TYPE string
  ASSERT $value INSIDE ["admin", "editor", "viewer"];
DEFINE FIELD IF NOT EXISTS joined_at ON TABLE has_workspace_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS has_workspace_member_unique ON TABLE has_workspace_member COLUMNS in, out UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- WORKBOOK
-- workbook 对应一个 Univer Workbook（unitId）。
-- 归属 workspace 用字段表示（workbook.workspace），无需单独的边。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE OVERWRITE workbook SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace         ON TABLE workbook TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name              ON TABLE workbook TYPE string;
DEFINE FIELD IF NOT EXISTS template_key      ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS folder            ON TABLE workbook TYPE option<record<folder>>;
DEFINE FIELD IF NOT EXISTS last_opened_sheet ON TABLE workbook TYPE option<record<sheet>>;
DEFINE FIELD IF NOT EXISTS created_at        ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at        ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_workspace ON TABLE workbook COLUMNS workspace;
DEFINE INDEX IF NOT EXISTS workbook_folder    ON TABLE workbook COLUMNS folder;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FOLDER
-- 层级文件夹，用于"我的文档"文件树。
-- 父子关系用 parent 字段表示（option<record<folder>>）。
-- workbook 归属文件夹用 workbook.folder 字段表示。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS folder SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE folder TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name       ON TABLE folder TYPE string;
DEFINE FIELD IF NOT EXISTS parent     ON TABLE folder TYPE option<record<folder>>;
DEFINE FIELD IF NOT EXISTS position   ON TABLE folder TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE folder TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE folder TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS folder_workspace ON TABLE folder COLUMNS workspace;
DEFINE INDEX IF NOT EXISTS folder_parent    ON TABLE folder COLUMNS parent;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SHEET
-- sheet 是一等实体，对应 Univer 的一个 tab。
-- 归属 workbook 用字段表示（sheet.workbook），无需单独的边。
-- sheet 是列定义的唯一来源（column_defs）。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS sheet SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workbook.workspace.owner = $auth
      OR workbook.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update WHERE
      workbook.workspace.owner = $auth,
    FOR delete WHERE
      workbook.workspace.owner = $auth;

DEFINE FIELD IF NOT EXISTS workbook    ON TABLE sheet TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS univer_id   ON TABLE sheet TYPE string;
DEFINE FIELD IF NOT EXISTS table_name  ON TABLE sheet TYPE string;
DEFINE FIELD IF NOT EXISTS label       ON TABLE sheet TYPE string;
DEFINE FIELD IF NOT EXISTS position    ON TABLE sheet TYPE int DEFAULT 0;
REMOVE FIELD IF EXISTS column_defs.* ON TABLE sheet;
DEFINE FIELD OVERWRITE column_defs ON TABLE sheet TYPE any DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at  ON TABLE sheet TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at  ON TABLE sheet TYPE datetime VALUE time::now();

DEFINE INDEX IF NOT EXISTS sheet_univer_id  ON TABLE sheet COLUMNS univer_id UNIQUE;
DEFINE INDEX IF NOT EXISTS sheet_table_name ON TABLE sheet COLUMNS table_name UNIQUE;
DEFINE INDEX IF NOT EXISTS sheet_workbook   ON TABLE sheet COLUMNS workbook;

-- ═══════════════════════════════════════════════════════════════════════════════
-- EDGE CATALOG
-- workspace 级别的关系类型注册表。每行代表一种可在本 workspace 使用的边类型。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS edge_catalog SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE edge_catalog TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS key        ON TABLE edge_catalog TYPE string;
DEFINE FIELD IF NOT EXISTS label      ON TABLE edge_catalog TYPE string;
DEFINE FIELD IF NOT EXISTS rel_table  ON TABLE edge_catalog TYPE string;
DEFINE FIELD IF NOT EXISTS from_table ON TABLE edge_catalog TYPE option<string>;
DEFINE FIELD IF NOT EXISTS to_table   ON TABLE edge_catalog TYPE option<string>;
REMOVE FIELD IF EXISTS edge_props.* ON TABLE edge_catalog;
DEFINE FIELD OVERWRITE edge_props ON TABLE edge_catalog TYPE any DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE edge_catalog TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS edge_catalog_ws_key_unique
  ON TABLE edge_catalog COLUMNS workspace, key UNIQUE;
DEFINE INDEX IF NOT EXISTS edge_catalog_ws_rel_table_unique
  ON TABLE edge_catalog COLUMNS workspace, rel_table UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DASHBOARD
-- 工作区级仪表盘页面与统计视图定义。
-- page 负责布局；view 负责只读统计 SQL / builder spec；cache 负责最近一次执行结果。
-- 布局属于系统结构关系，用字段数组表示，不单独建 relation。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS dashboard_page SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace   ON TABLE dashboard_page TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title       ON TABLE dashboard_page TYPE string;
DEFINE FIELD IF NOT EXISTS slug        ON TABLE dashboard_page TYPE string;
DEFINE FIELD IF NOT EXISTS description ON TABLE dashboard_page TYPE option<string>;
REMOVE FIELD IF EXISTS widgets.* ON TABLE dashboard_page;
DEFINE FIELD OVERWRITE widgets         ON TABLE dashboard_page TYPE any DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at  ON TABLE dashboard_page TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at  ON TABLE dashboard_page TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS dashboard_page_ws_slug_unique
  ON TABLE dashboard_page COLUMNS workspace, slug UNIQUE;
DEFINE INDEX IF NOT EXISTS dashboard_page_workspace
  ON TABLE dashboard_page COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS dashboard_view SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace       ON TABLE dashboard_view TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title           ON TABLE dashboard_view TYPE string;
DEFINE FIELD IF NOT EXISTS slug            ON TABLE dashboard_view TYPE string;
DEFINE FIELD IF NOT EXISTS description     ON TABLE dashboard_view TYPE option<string>;
DEFINE FIELD IF NOT EXISTS query_mode      ON TABLE dashboard_view TYPE string
  ASSERT $value INSIDE ["preset", "builder", "sql"];
DEFINE FIELD IF NOT EXISTS view_type       ON TABLE dashboard_view TYPE string
  ASSERT $value INSIDE ["kpi", "table", "bar", "line"];
DEFINE FIELD IF NOT EXISTS result_contract ON TABLE dashboard_view TYPE string
  ASSERT $value INSIDE ["single_value", "category_breakdown", "time_series", "table_rows"];
DEFINE FIELD IF NOT EXISTS compiled_sql    ON TABLE dashboard_view TYPE string;
DEFINE FIELD IF NOT EXISTS status          ON TABLE dashboard_view TYPE string
  ASSERT $value INSIDE ["draft", "active", "invalid"];
DEFINE FIELD IF NOT EXISTS version         ON TABLE dashboard_view TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS created_by      ON TABLE dashboard_view TYPE option<record<app_user>>;
DEFINE FIELD IF NOT EXISTS last_run_at     ON TABLE dashboard_view TYPE option<datetime>;
REMOVE FIELD IF EXISTS builder_spec.* ON TABLE dashboard_view;
REMOVE FIELD IF EXISTS display_spec.* ON TABLE dashboard_view;
REMOVE FIELD IF EXISTS source_tables.* ON TABLE dashboard_view;
REMOVE FIELD IF EXISTS dependencies.* ON TABLE dashboard_view;
DEFINE FIELD OVERWRITE builder_spec        ON TABLE dashboard_view TYPE any DEFAULT {};
DEFINE FIELD OVERWRITE display_spec        ON TABLE dashboard_view TYPE any DEFAULT {};
DEFINE FIELD OVERWRITE source_tables       ON TABLE dashboard_view TYPE any DEFAULT [];
DEFINE FIELD OVERWRITE dependencies        ON TABLE dashboard_view TYPE any DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at      ON TABLE dashboard_view TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at      ON TABLE dashboard_view TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS dashboard_view_ws_slug_unique
  ON TABLE dashboard_view COLUMNS workspace, slug UNIQUE;
DEFINE INDEX IF NOT EXISTS dashboard_view_workspace_status
  ON TABLE dashboard_view COLUMNS workspace, status;
DEFINE INDEX IF NOT EXISTS dashboard_view_workspace
  ON TABLE dashboard_view COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS dashboard_result_cache SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      view.workspace.owner = $auth
      OR view.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      view.workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS view         ON TABLE dashboard_result_cache TYPE record<dashboard_view>;
DEFINE FIELD IF NOT EXISTS status       ON TABLE dashboard_result_cache TYPE string
  ASSERT $value INSIDE ["ok", "error", "stale", "running"];
DEFINE FIELD IF NOT EXISTS rows_count   ON TABLE dashboard_result_cache TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS duration_ms  ON TABLE dashboard_result_cache TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS sql_hash     ON TABLE dashboard_result_cache TYPE string;
DEFINE FIELD IF NOT EXISTS executed_at  ON TABLE dashboard_result_cache TYPE datetime VALUE time::now();
REMOVE FIELD IF EXISTS result_json.* ON TABLE dashboard_result_cache;
REMOVE FIELD IF EXISTS result_meta.* ON TABLE dashboard_result_cache;
REMOVE FIELD IF EXISTS error_detail.* ON TABLE dashboard_result_cache;
DEFINE FIELD OVERWRITE result_json    ON TABLE dashboard_result_cache TYPE any DEFAULT null;
DEFINE FIELD OVERWRITE result_meta    ON TABLE dashboard_result_cache TYPE any DEFAULT {};
DEFINE FIELD OVERWRITE error_detail   ON TABLE dashboard_result_cache TYPE any DEFAULT null;
DEFINE INDEX IF NOT EXISTS dashboard_result_cache_view_unique
  ON TABLE dashboard_result_cache COLUMNS view UNIQUE;

DEFINE TABLE IF NOT EXISTS dashboard_run_log SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      view.workspace.owner = $auth
      OR view.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE
      view.workspace.owner = $auth,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS view         ON TABLE dashboard_run_log TYPE record<dashboard_view>;
DEFINE FIELD IF NOT EXISTS status       ON TABLE dashboard_run_log TYPE string;
DEFINE FIELD IF NOT EXISTS duration_ms  ON TABLE dashboard_run_log TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS sql_hash     ON TABLE dashboard_run_log TYPE string;
DEFINE FIELD IF NOT EXISTS executed_at  ON TABLE dashboard_run_log TYPE datetime VALUE time::now();
REMOVE FIELD IF EXISTS result_meta.* ON TABLE dashboard_run_log;
REMOVE FIELD IF EXISTS error_detail.* ON TABLE dashboard_run_log;
DEFINE FIELD OVERWRITE result_meta    ON TABLE dashboard_run_log TYPE any DEFAULT {};
DEFINE FIELD OVERWRITE error_detail   ON TABLE dashboard_run_log TYPE any DEFAULT null;
DEFINE INDEX IF NOT EXISTS dashboard_run_log_view_ts
  ON TABLE dashboard_run_log COLUMNS view, executed_at;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COLLABORATION: MUTATION + SNAPSHOT
--
-- 业务数据（实体行）存储在动态实体表中，是 cell 值的唯一来源。
-- Univer 拥有的是布局状态（列宽、行高、样式、公式、行顺序）。
--
-- mutation：仅追加的 Univer 布局命令日志。
-- snapshot：workbook 完整布局状态的周期性快照（不含 cell 值）。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS mutation SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workbook.workspace.owner = $auth
      OR workbook.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE
      workbook.workspace.owner = $auth
      OR workbook.workspace IN $auth<-has_workspace_member<-workspace,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workbook   ON TABLE mutation TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS command_id ON TABLE mutation TYPE string;
DEFINE FIELD OVERWRITE params         ON TABLE mutation TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS client_id  ON TABLE mutation TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE mutation TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS mutation_workbook_ts ON TABLE mutation COLUMNS workbook, created_at;

DEFINE TABLE IF NOT EXISTS snapshot SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workbook.workspace.owner = $auth
      OR workbook.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE
      workbook.workspace.owner = $auth
      OR workbook.workspace IN $auth<-has_workspace_member<-workspace,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workbook              ON TABLE snapshot TYPE record<workbook>;
DEFINE FIELD OVERWRITE layout                ON TABLE snapshot TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS coordinator_client_id ON TABLE snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS mutation_watermark    ON TABLE snapshot TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at            ON TABLE snapshot TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS snapshot_workbook_ts  ON TABLE snapshot COLUMNS workbook, created_at;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PRESENCE
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS presence SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workbook.workspace.owner = $auth
      OR workbook.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE $auth != NONE;
DEFINE FIELD IF NOT EXISTS workbook   ON TABLE presence TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS client_id  ON TABLE presence TYPE string;
DEFINE FIELD IF NOT EXISTS cursor     ON TABLE presence TYPE option<object>;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE presence TYPE datetime;
DEFINE INDEX OVERWRITE presence_client_id ON TABLE presence COLUMNS workbook, client_id UNIQUE;
DEFINE INDEX IF NOT EXISTS presence_workbook  ON TABLE presence COLUMNS workbook;

-- ═══════════════════════════════════════════════════════════════════════════════
-- INTAKE FORMS
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS form_definition SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace        ON TABLE form_definition TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title            ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS slug             ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS target_sheet     ON TABLE form_definition TYPE record<sheet>;
-- 表单封面图片 URL（可选，用于填写表单时展示头图）
DEFINE FIELD IF NOT EXISTS cover_url        ON TABLE form_definition TYPE option<string>;
-- 表单详细说明（富文本/纯文本，渲染在表单顶部，向填写人展示填写须知）
DEFINE FIELD IF NOT EXISTS description      ON TABLE form_definition TYPE option<string>;
REMOVE FIELD IF EXISTS fields.* ON TABLE form_definition;
REMOVE FIELD IF EXISTS conditional_rules.* ON TABLE form_definition;
REMOVE FIELD IF EXISTS auto_edges.* ON TABLE form_definition;
REMOVE FIELD IF EXISTS field_order.* ON TABLE form_definition;
-- fields[]: 表单字段配置项 { key, label, field_type, required, included, position }
--   required=true 的字段强制 included=true，前端不可移除
--   included=false 表示该非必填字段未加入表单（数据表存在但未被表单展示）
--   position 决定字段渲染顺序（数字越小越靠前）
DEFINE FIELD OVERWRITE fields            ON TABLE form_definition TYPE any DEFAULT [];
-- field_order[]: 仅记录 key 的顺序数组，可作为 fields[].position 之外的更轻量排序来源
DEFINE FIELD OVERWRITE field_order       ON TABLE form_definition TYPE any DEFAULT [];
DEFINE FIELD OVERWRITE conditional_rules ON TABLE form_definition TYPE any DEFAULT [];
DEFINE FIELD OVERWRITE auto_edges        ON TABLE form_definition TYPE any DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at       ON TABLE form_definition TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at       ON TABLE form_definition TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS form_definition_workspace_slug_unique
  ON TABLE form_definition COLUMNS workspace, slug UNIQUE;

DEFINE TABLE IF NOT EXISTS intake_submission SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workspace      ON TABLE intake_submission TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS form           ON TABLE intake_submission TYPE record<form_definition>;
DEFINE FIELD IF NOT EXISTS created_record ON TABLE intake_submission TYPE option<string>;
DEFINE FIELD IF NOT EXISTS payload        ON TABLE intake_submission TYPE object;
DEFINE FIELD IF NOT EXISTS unverified     ON TABLE intake_submission TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at     ON TABLE intake_submission TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS intake_submission_workspace ON TABLE intake_submission COLUMNS workspace;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FILES
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS workbook_file SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace     ON TABLE workbook_file TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS attached_to   ON TABLE workbook_file TYPE option<string>;
DEFINE FIELD IF NOT EXISTS bucket_path   ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS original_name ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS mime_type     ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS size_bytes    ON TABLE workbook_file TYPE int;
DEFINE FIELD IF NOT EXISTS uploaded_by   ON TABLE workbook_file TYPE record<app_user>;
DEFINE FIELD IF NOT EXISTS created_at    ON TABLE workbook_file TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_file_workspace ON TABLE workbook_file COLUMNS workspace;

-- ═══════════════════════════════════════════════════════════════════════════════
-- OBSERVABILITY
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS client_error SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE client_error TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS workbook   ON TABLE client_error TYPE option<record<workbook>>;
DEFINE FIELD IF NOT EXISTS client_id  ON TABLE client_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS message    ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS stack      ON TABLE client_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS meta       ON TABLE client_error TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE client_error TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS client_error_ts ON TABLE client_error COLUMNS created_at;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FILE STORAGE BUCKET
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE BUCKET IF NOT EXISTS spreadsheet_files BACKEND "file:/data/uploads" PERMISSIONS FULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOKEN STORE
-- 存储当前用户的 OIDC tokens，用于进程重启后自动恢复登录。
-- 仅存在于用户专属 DB（NS main / DB u_<hash>），始终使用固定 ID token_store:local。
-- embedded engine 下 $auth = NONE，PERMISSIONS FULL 语义清晰且无副作用。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS token_store SCHEMAFULL
  PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS access_token  ON TABLE token_store TYPE string;
DEFINE FIELD IF NOT EXISTS refresh_token ON TABLE token_store TYPE option<string>;
DEFINE FIELD IF NOT EXISTS expires_at    ON TABLE token_store TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at    ON TABLE token_store TYPE datetime VALUE time::now();

-- ═══════════════════════════════════════════════════════════════════════════════
-- AUTH ACCESS
-- JWT 由外部 OIDC 提供方（maplayer.top）签发。
-- 首次登录时：创建 app_user，自动认领 pending_workspace_member 邀请并写入
-- has_workspace_member 边，自动为无 workspace 的用户创建默认 workspace。
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE ACCESS OVERWRITE madocs ON DATABASE TYPE RECORD
  WITH JWT URL 'https://o.maplayer.top/t/ck/jwks.json'
  AUTHENTICATE {

    IF type::is_array($token.aud) AND $token.aud CONTAINS 'https://auth.maplayer.top'
      OR $token.aud = 'https://auth.maplayer.top'
    {
      IF !$token.sub { THROW 'Missing sub claim' };

      LET $user_id  = type::record('app_user', $token.sub);
      LET $existing = (SELECT VALUE id FROM ONLY $user_id);

      IF !$existing {
        LET $display_name =
          IF $token.name               { <string>$token.name               }
          ELSE IF $token.preferred_username { <string>$token.preferred_username }
          ELSE IF $token['https://surrealdb.com/email']         { <string>$token['https://surrealdb.com/email']              }
          ELSE                         { <string>$token.sub                };

        CREATE $user_id CONTENT {
          display_name: $display_name,
          email:        $token['https://surrealdb.com/email'],
          subject:      $token.sub,
          avatar:       IF $token.picture { <string>$token.picture } ELSE { NONE },
          created_at:   time::now(),
          updated_at:   time::now()
        };
      };

      -- 自动认领：将匹配邮箱的 pending_workspace_member 转换为正式 has_workspace_member 边。
      -- 在 AUTHENTICATE 块内以系统权限运行，绕过行级权限。
      IF $token['https://surrealdb.com/email'] {
        LET $pending = (
          SELECT id, workspace, role FROM pending_workspace_member
          WHERE email = <string>$token['https://surrealdb.com/email']
        );
        FOR $inv IN $pending {
          LET $ws = $inv.workspace;
          RELATE $ws->has_workspace_member->$user_id CONTENT {
            role:      $inv.role,
            joined_at: time::now()
          };
          DELETE $inv.id;
        };
      };

      -- 自动创建默认 workspace（首次登录且无 workspace 时）。
      LET $has_workspace = (SELECT VALUE id FROM workspace WHERE owner = $user_id LIMIT 1);
      IF array::len($has_workspace) = 0 {
        LET $display = IF $token.name { <string>$token.name }
                       ELSE IF $token.preferred_username { <string>$token.preferred_username }
                       ELSE IF $token['https://surrealdb.com/email'] { <string>$token['https://surrealdb.com/email'] }
                       ELSE { <string>$token.sub };
        CREATE workspace CONTENT {
          owner:      $user_id,
          name:       $display + ' 的空间',
          slug:       'ws-' + string::slice(<string>$token.sub, 0, 16),
          created_at: time::now()
        };
      };

      RETURN $user_id;

    } ELSE {
      THROW 'not allowed'
    }

  } DURATION FOR TOKEN 1h, FOR SESSION NONE;
