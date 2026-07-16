-- OIP-18：每日债权风险检查状态与用户通知收件箱。
-- 每个 workspace 对应独立 database，因此 check_date 唯一即表达“每工作区每天一次”。

DEFINE FIELD IF NOT EXISTS risk_reminders_enabled ON TABLE workbook TYPE bool DEFAULT false;

DEFINE TABLE IF NOT EXISTS risk_check_run SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.kind = "virtual",
    FOR update WHERE employee = $auth,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS check_date ON TABLE risk_check_run TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE risk_check_run TYPE string
  ASSERT $value INSIDE ["running", "completed", "failed"];
DEFINE FIELD IF NOT EXISTS employee ON TABLE risk_check_run TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS started_at ON TABLE risk_check_run TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE risk_check_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS error_message ON TABLE risk_check_run TYPE option<string>;
DEFINE INDEX IF NOT EXISTS risk_check_run_date_unique ON TABLE risk_check_run COLUMNS check_date UNIQUE;

DEFINE TABLE IF NOT EXISTS user_notification SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE to_user = fn::current_user() OR fn::current_user().is_admin = true,
    FOR create WHERE $auth.kind = "virtual",
    FOR update WHERE to_user = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete WHERE fn::current_user().is_admin = true;
DEFINE FIELD IF NOT EXISTS dedupe_key ON TABLE user_notification TYPE string;
DEFINE FIELD IF NOT EXISTS to_user ON TABLE user_notification TYPE record<user>;
DEFINE FIELD IF NOT EXISTS from_employee ON TABLE user_notification TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS workbook ON TABLE user_notification TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS related_record ON TABLE user_notification TYPE record;
DEFINE FIELD IF NOT EXISTS risk_type ON TABLE user_notification TYPE string
  ASSERT $value INSIDE ["missing-material", "due-within-seven-days", "amount-anomaly"];
DEFINE FIELD IF NOT EXISTS title ON TABLE user_notification TYPE string;
DEFINE FIELD IF NOT EXISTS body ON TABLE user_notification TYPE string;
DEFINE FIELD IF NOT EXISTS severity ON TABLE user_notification TYPE string
  ASSERT $value INSIDE ["info", "warning", "urgent"];
DEFINE FIELD IF NOT EXISTS requested_action ON TABLE user_notification TYPE option<string>;
DEFINE FIELD IF NOT EXISTS matched_fields ON TABLE user_notification TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS rule ON TABLE user_notification TYPE string;
DEFINE FIELD IF NOT EXISTS checked_at ON TABLE user_notification TYPE datetime;
DEFINE FIELD IF NOT EXISTS resolution ON TABLE user_notification TYPE option<string>;
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE user_notification TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE user_notification TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS user_notification_dedupe_unique ON TABLE user_notification COLUMNS dedupe_key UNIQUE;
DEFINE INDEX IF NOT EXISTS user_notification_inbox ON TABLE user_notification COLUMNS to_user, resolved_at, created_at;
