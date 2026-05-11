-- Remote schema template v1.
-- This template is intentionally maintained from docs/adr/sync.md + schema/main.surql.
-- It defines the remote source-of-truth sync surface, CHANGEFEED metadata, and schema version.

DEFINE TABLE IF NOT EXISTS schema_version SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS version ON TABLE schema_version TYPE int;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE schema_version TYPE datetime VALUE time::now();
UPSERT schema_version:current CONTENT { version: 1, updated_at: time::now() };

-- Base application schema is deployed by the maintainer from schema/main.surql.
-- The proxy strips local-only tables before execution and keeps the PERMISSIONS blocks from schema/main.surql.
-- The following assertions are kept in-template so deployment validation can fail closed if a table is missing.
DEFINE TABLE IF NOT EXISTS app_user SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS has_workspace_member TYPE RELATION IN workspace OUT app_user SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS pending_workspace_member SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS workbook SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS folder SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS sheet SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS edge_catalog SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS mutation SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS snapshot SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS presence SCHEMALESS CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS dashboard_page SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS dashboard_view SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS form_definition SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS intake_submission SCHEMALESS CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS workbook_file SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS research_session SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS resource_item SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS resource_embedding SCHEMAFULL CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS client_error SCHEMALESS CHANGEFEED 7d;
DEFINE TABLE IF NOT EXISTS app_setting SCHEMAFULL CHANGEFEED 7d;

DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE has_workspace_member TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE pending_workspace_member TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE folder TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE sheet TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE edge_catalog TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE mutation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE snapshot TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE presence TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE dashboard_page TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE dashboard_view TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE form_definition TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE intake_submission TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE workbook_file TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE research_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE resource_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE resource_embedding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE client_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE app_setting TYPE option<string>;

DEFINE EVENT OVERWRITE app_user_origin_session ON TABLE app_user WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE workspace_origin_session ON TABLE workspace WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE has_workspace_member_origin_session ON TABLE has_workspace_member WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE pending_workspace_member_origin_session ON TABLE pending_workspace_member WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE workbook_origin_session ON TABLE workbook WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE folder_origin_session ON TABLE folder WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE sheet_origin_session ON TABLE sheet WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE edge_catalog_origin_session ON TABLE edge_catalog WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE mutation_origin_session ON TABLE mutation WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE snapshot_origin_session ON TABLE snapshot WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE presence_origin_session ON TABLE presence WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE dashboard_page_origin_session ON TABLE dashboard_page WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE dashboard_view_origin_session ON TABLE dashboard_view WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE form_definition_origin_session ON TABLE form_definition WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE intake_submission_origin_session ON TABLE intake_submission WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE workbook_file_origin_session ON TABLE workbook_file WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE research_session_origin_session ON TABLE research_session WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE resource_item_origin_session ON TABLE resource_item WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE resource_embedding_origin_session ON TABLE resource_embedding WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE client_error_origin_session ON TABLE client_error WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
DEFINE EVENT OVERWRITE app_setting_origin_session ON TABLE app_setting WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
