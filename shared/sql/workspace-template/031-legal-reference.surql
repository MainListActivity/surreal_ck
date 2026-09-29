-- Workspace-owned pointer and personal note. Platform body text never enters this table.
DEFINE TABLE IF NOT EXISTS legal_reference SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth != NONE,
    FOR update, delete WHERE created_by = $auth;
DEFINE FIELD IF NOT EXISTS content_public_id ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS content_version_id ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS title ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS source_url ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS published_on ON legal_reference TYPE option<string>;
DEFINE FIELD IF NOT EXISTS locator ON legal_reference TYPE option<string>;
DEFINE FIELD IF NOT EXISTS note ON legal_reference TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 4000;
DEFINE FIELD IF NOT EXISTS created_by ON legal_reference TYPE record<user> DEFAULT $auth
  ASSERT $value = $auth READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON legal_reference TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS legal_reference_version ON legal_reference FIELDS content_version_id;
