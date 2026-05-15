-- DDL template: remove a field from a workspace-scoped entity table.
-- Executed via the proxy service (POST /api/db/execTemplate).
--
-- Params:
--   table_name -- e.g. "ent_k3f8x2_company"
--   field_name -- e.g. "status"

REMOVE FIELD IF EXISTS $field_name ON TABLE $table_name;
