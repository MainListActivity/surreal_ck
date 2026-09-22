-- 真人派单、处理提交与复核闭环。

DEFINE TABLE IF NOT EXISTS finding_assignment SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create WHERE fn::current_user() != NONE,
    FOR update WHERE assignee = fn::current_user() OR reviewer = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS findings ON TABLE finding_assignment TYPE array<record<data_check_finding>>;
DEFINE FIELD IF NOT EXISTS assignee ON TABLE finding_assignment TYPE record<user>;
DEFINE FIELD IF NOT EXISTS reviewer ON TABLE finding_assignment TYPE record<user>;
DEFINE FIELD IF NOT EXISTS due_at ON TABLE finding_assignment TYPE datetime;
DEFINE FIELD IF NOT EXISTS completion_condition ON TABLE finding_assignment TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 500;
DEFINE FIELD IF NOT EXISTS status ON TABLE finding_assignment TYPE string DEFAULT "active"
  ASSERT $value INSIDE ["active", "submitted", "returned", "completed", "cancelled"];
DEFINE FIELD IF NOT EXISTS submission_note ON TABLE finding_assignment TYPE option<string>;
DEFINE FIELD IF NOT EXISTS resource_refs ON TABLE finding_assignment TYPE array<record> DEFAULT [];
DEFINE FIELD IF NOT EXISTS review_reason ON TABLE finding_assignment TYPE option<string>;
DEFINE FIELD IF NOT EXISTS version ON TABLE finding_assignment TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE finding_assignment TYPE string;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE finding_assignment TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE finding_assignment TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS submitted_at ON TABLE finding_assignment TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS reviewed_at ON TABLE finding_assignment TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE finding_assignment TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS finding_assignment_idempotency_unique ON TABLE finding_assignment COLUMNS idempotency_key UNIQUE;

DEFINE FIELD IF NOT EXISTS active_assignment ON TABLE data_check_finding TYPE option<record<finding_assignment>>;
DEFINE FIELD IF NOT EXISTS handlers ON TABLE data_check_finding TYPE array<record<user>> DEFAULT [];
UPDATE data_check_finding SET handlers = [] WHERE handlers = NONE;
DEFINE FIELD OVERWRITE status ON TABLE data_check_finding TYPE string DEFAULT "pending"
  ASSERT $value INSIDE ["pending", "processing", "pending_review", "closed", "not_applicable"];
DEFINE TABLE OVERWRITE data_check_finding SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create WHERE fn::current_user() != NONE,
    FOR update WHERE created_by = fn::current_user()
      OR fn::current_user().is_admin = true
      OR fn::current_user() INSIDE handlers,
    FOR delete NONE;

DEFINE TABLE IF NOT EXISTS finding_assignment_event SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS FOR select, create WHERE fn::current_user() != NONE, FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS assignment ON TABLE finding_assignment_event TYPE record<finding_assignment>;
DEFINE FIELD IF NOT EXISTS kind ON TABLE finding_assignment_event TYPE string
  ASSERT $value INSIDE ["created", "submitted", "returned", "approved"];
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE finding_assignment_event TYPE string;
DEFINE FIELD IF NOT EXISTS note ON TABLE finding_assignment_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actor ON TABLE finding_assignment_event TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE finding_assignment_event TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS finding_assignment_event_idempotency_unique ON TABLE finding_assignment_event COLUMNS idempotency_key UNIQUE;
