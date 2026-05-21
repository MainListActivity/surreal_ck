DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS db_name ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS owner_subject ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS name ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE workspace TYPE string
  ASSERT $value INSIDE ["provisioning", "active", "failed", "archived"];
DEFINE FIELD IF NOT EXISTS last_migration_version ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_migration_error ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workspace TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS archived_at ON TABLE workspace TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS workspace_db_name_unique ON TABLE workspace COLUMNS db_name UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_slug_unique ON TABLE workspace COLUMNS slug UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_status ON TABLE workspace COLUMNS status;

DEFINE TABLE IF NOT EXISTS user_workspace_index SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS subject ON TABLE user_workspace_index TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE user_workspace_index TYPE option<string>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE user_workspace_index TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS db_name ON TABLE user_workspace_index TYPE string;
DEFINE FIELD IF NOT EXISTS role ON TABLE user_workspace_index TYPE string
  ASSERT $value INSIDE ["admin", "participant"];
DEFINE FIELD IF NOT EXISTS joined_at ON TABLE user_workspace_index TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS last_selected_at ON TABLE user_workspace_index TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE user_workspace_index TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS disabled_at ON TABLE user_workspace_index TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS user_workspace_subject ON TABLE user_workspace_index COLUMNS subject;
DEFINE INDEX IF NOT EXISTS user_workspace_workspace ON TABLE user_workspace_index COLUMNS workspace;
DEFINE INDEX IF NOT EXISTS user_workspace_subject_workspace_unique
  ON TABLE user_workspace_index COLUMNS subject, workspace UNIQUE;

DEFINE TABLE IF NOT EXISTS _system_schema_version SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS version ON TABLE _system_schema_version TYPE int;
DEFINE FIELD IF NOT EXISTS applied_at ON TABLE _system_schema_version TYPE datetime VALUE time::now();
