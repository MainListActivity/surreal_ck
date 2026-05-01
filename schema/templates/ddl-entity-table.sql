-- DDL template: provision a workspace-scoped SCHEMALESS entity table.
-- Executed via the proxy service (POST /api/db/execTemplate).
--
-- Params:
--   table_name  -- e.g. "ent_k3f8x2_company"

DEFINE TABLE IF NOT EXISTS $table_name SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace.owner = $auth
      OR workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE $table_name TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE $table_name TYPE option<record<app_user>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $table_name TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE $table_name TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE $table_name COLUMNS workspace;
