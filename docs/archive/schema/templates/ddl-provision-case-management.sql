-- DDL template: provision all entity and relation tables for the Case Management template.
-- Executed via the proxy service (POST /api/db/execTemplate).
--
-- Params:
--   ws_key  -- workspace nanoid prefix, e.g. "k3f8x2"

LET $tbl_case       = "ent_" + $ws_key + "_case";
LET $tbl_client     = "ent_" + $ws_key + "_client";
LET $tbl_document   = "ent_" + $ws_key + "_document";
LET $rel_assigned   = "rel_" + $ws_key + "_assigned_to";
LET $rel_filed_in   = "rel_" + $ws_key + "_filed_in";
LET $rel_belongs_to = "rel_" + $ws_key + "_belongs_to";

DEFINE TABLE IF NOT EXISTS $tbl_case SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $tbl_case TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE $tbl_case TYPE option<record<app_user>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $tbl_case TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $tbl_case TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $tbl_case COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS $tbl_client SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $tbl_client TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE $tbl_client TYPE option<record<app_user>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $tbl_client TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $tbl_client TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $tbl_client COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS $tbl_document SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $tbl_document TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE $tbl_document TYPE option<record<app_user>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $tbl_document TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $tbl_document TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $tbl_document COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS $rel_assigned TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $rel_assigned TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS $rel_filed_in TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $rel_filed_in TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS $rel_belongs_to TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $rel_belongs_to TYPE datetime VALUE time::now();
