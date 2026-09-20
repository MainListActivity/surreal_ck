-- DDL template: add a field to a workspace-scoped entity table.
-- Executed via the proxy service (POST /api/db/execTemplate).
--
-- Params:
--   table_name   -- e.g. "ent_k3f8x2_company"
--   field_name   -- e.g. "status"
--   field_type   -- e.g. "option<string>"
--   field_assert -- optional ASSERT clause, or empty string

DEFINE FIELD IF NOT EXISTS $field_name ON TABLE $table_name TYPE $field_type $field_assert;
