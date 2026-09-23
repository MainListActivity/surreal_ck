-- 体检问题修正状态与不可变处理事件。

UPDATE data_check_finding SET status = "pending" WHERE status = "open";
UPDATE data_check_finding SET status = "closed" WHERE status = "resolved";
UPDATE data_check_finding SET status = "not_applicable" WHERE status = "ignored";
DEFINE FIELD OVERWRITE status ON TABLE data_check_finding TYPE string DEFAULT "pending"
  ASSERT $value INSIDE ["pending", "processing", "pending_review", "closed", "not_applicable"];
DEFINE FIELD IF NOT EXISTS resolution_reason ON TABLE data_check_finding TYPE option<string>
  ASSERT $value = NONE OR (string::len($value) > 0 AND string::len($value) <= 500);
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE data_check_finding TYPE option<datetime>;

DEFINE TABLE IF NOT EXISTS data_check_finding_event SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create WHERE fn::current_user() != NONE,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS finding ON TABLE data_check_finding_event TYPE record<data_check_finding>;
DEFINE FIELD IF NOT EXISTS kind ON TABLE data_check_finding_event TYPE string
  ASSERT $value INSIDE ["processing_started", "repair_confirmed", "marked_not_applicable", "reopened", "review_approved", "review_returned"];
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE data_check_finding_event TYPE string;
DEFINE FIELD IF NOT EXISTS field ON TABLE data_check_finding_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS before_value ON TABLE data_check_finding_event TYPE any;
DEFINE FIELD IF NOT EXISTS after_value ON TABLE data_check_finding_event TYPE any;
DEFINE FIELD IF NOT EXISTS reason ON TABLE data_check_finding_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actor ON TABLE data_check_finding_event TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE data_check_finding_event TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS data_check_finding_event_idempotency_unique ON TABLE data_check_finding_event COLUMNS idempotency_key UNIQUE;
