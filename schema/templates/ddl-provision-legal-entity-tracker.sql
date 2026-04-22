-- DDL template: provision all entity and relation tables for the Legal Entity Tracker template.
-- Executed via the proxy service (POST /api/db/execTemplate).
--
-- Params:
--   ws_key  -- workspace nanoid prefix, e.g. "k3f8x2"

LET $tbl_company  = "ent_" + $ws_key + "_company";
LET $tbl_person   = "ent_" + $ws_key + "_person";
LET $tbl_trust    = "ent_" + $ws_key + "_trust";
LET $rel_owns     = "rel_" + $ws_key + "_owns";
LET $rel_controls = "rel_" + $ws_key + "_controls";
LET $rel_filed_by = "rel_" + $ws_key + "_filed_by";

DEFINE TABLE IF NOT EXISTS $tbl_company SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $tbl_company TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $tbl_company TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $tbl_company TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $tbl_company COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS $tbl_person SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $tbl_person TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $tbl_person TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $tbl_person TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $tbl_person COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS $tbl_trust SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $tbl_trust TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $tbl_trust TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $tbl_trust TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $tbl_trust COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS $rel_owns TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $rel_owns TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS $rel_controls TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $rel_controls TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS $rel_filed_by TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $rel_filed_by TYPE datetime VALUE time::now();
