DEFINE TABLE IF NOT EXISTS workflow_run SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR create WHERE owner_user = $auth,
    FOR update WHERE owner_user = $auth,
    FOR delete WHERE owner_user = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS owner_user ON TABLE workflow_run TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS run_id ON TABLE workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS workflow_name ON TABLE workflow_run TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON TABLE workflow_run TYPE string
  ASSERT $value INSIDE ["router", "office-employee"];
DEFINE FIELD IF NOT EXISTS state ON TABLE workflow_run TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS status ON TABLE workflow_run TYPE string
  ASSERT $value INSIDE ["running", "suspended", "done", "failed", "cancelled"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workflow_run TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workflow_run TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workflow_run_id_unique ON TABLE workflow_run COLUMNS run_id UNIQUE;
DEFINE INDEX IF NOT EXISTS workflow_run_owner_status ON TABLE workflow_run COLUMNS owner_user, status;
