-- DDL template: provision a workspace-scoped TYPE RELATION edge table.
-- Executed via the proxy service (POST /api/db/execTemplate).
--
-- Params:
--   table_name  -- e.g. "rel_k3f8x2_owns"

DEFINE TABLE IF NOT EXISTS $table_name TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace.owner = $auth
      OR in.workspace IN $auth<-has_workspace_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace.owner = $auth
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE $table_name TYPE datetime VALUE time::now();
