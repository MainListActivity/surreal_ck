-- params: table_name, from_table?, to_table?, fields?
DEFINE TABLE IF NOT EXISTS {{table_name}} TYPE RELATION SCHEMALESS CHANGEFEED 7d PERMISSIONS 
  FOR select WHERE
    workspace.owner = $auth
    OR workspace IN $auth<-has_workspace_member<-workspace,
  FOR create, update, delete WHERE
    workspace.owner = $auth;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE {{table_name}} TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE {{table_name}} TYPE option<string>;
DEFINE EVENT OVERWRITE {{table_name}}_origin_session ON TABLE {{table_name}}
  WHEN ($event = "CREATE" OR $event = "UPDATE") AND $after._origin_session_id = NONE
  THEN { UPDATE $after.id SET _origin_session_id = $current_session_id; };
