DEFINE TABLE IF NOT EXISTS office_role SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS key ON TABLE office_role TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE office_role TYPE string;
DEFINE FIELD IF NOT EXISTS system_prompt ON TABLE office_role TYPE string;
DEFINE FIELD IF NOT EXISTS tool_bundle_key ON TABLE office_role TYPE string;
DEFINE FIELD IF NOT EXISTS heartbeat_interval ON TABLE office_role TYPE duration DEFAULT 5m;
DEFINE FIELD IF NOT EXISTS daily_token_budget ON TABLE office_role TYPE int DEFAULT 200000;
DEFINE FIELD IF NOT EXISTS default_supervisor_role ON TABLE office_role TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE office_role TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE office_role TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS office_role_key_unique ON TABLE office_role COLUMNS key UNIQUE;

DEFINE TABLE IF NOT EXISTS employee_credential SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS employee ON TABLE employee_credential TYPE record<user>;
DEFINE FIELD IF NOT EXISTS secret ON TABLE employee_credential TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE employee_credential TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS rotated_at ON TABLE employee_credential TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS employee_credential_employee_unique
  ON TABLE employee_credential COLUMNS employee UNIQUE;
