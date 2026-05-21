DEFINE TABLE IF NOT EXISTS user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.is_admin = true,
    FOR update WHERE id = $auth OR $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS email ON TABLE user TYPE string;
DEFINE FIELD IF NOT EXISTS subject ON TABLE user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS kind ON TABLE user TYPE string
  ASSERT $value INSIDE ["human", "virtual"];
DEFINE FIELD IF NOT EXISTS is_admin ON TABLE user TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS avatar ON TABLE user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE user TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS virtual_profile ON TABLE user TYPE option<object>;
DEFINE FIELD IF NOT EXISTS disabled_at ON TABLE user TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE user TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS user_email_unique ON TABLE user COLUMNS email UNIQUE;
DEFINE INDEX IF NOT EXISTS user_subject_unique ON TABLE user COLUMNS subject UNIQUE;
DEFINE INDEX IF NOT EXISTS user_kind ON TABLE user COLUMNS kind;

DEFINE TABLE IF NOT EXISTS schema_version SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth.is_admin = true,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS version ON TABLE schema_version TYPE int;
DEFINE FIELD IF NOT EXISTS applied_at ON TABLE schema_version TYPE datetime VALUE time::now();
