-- 全范围数据体检运行与跨重扫合并的问题清单。

DEFINE TABLE IF NOT EXISTS data_check_run SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create WHERE fn::current_user() != NONE,
    FOR update WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE data_check_run TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS scope_sheets ON TABLE data_check_run TYPE array<record<sheet>>;
DEFINE FIELD IF NOT EXISTS rules_version ON TABLE data_check_run TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE data_check_run TYPE string ASSERT $value INSIDE ["processing", "completed", "partial", "failed", "cancelled"];
DEFINE FIELD IF NOT EXISTS scanned_count ON TABLE data_check_run TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS total_count ON TABLE data_check_run TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS finding_count ON TABLE data_check_run TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS stale ON TABLE data_check_run TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS error ON TABLE data_check_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE data_check_run TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE data_check_run TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE data_check_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE data_check_run TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS data_check_finding SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create WHERE fn::current_user() != NONE,
    FOR update WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE data_check_finding TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS sheet ON TABLE data_check_finding TYPE record<sheet>;
DEFINE FIELD IF NOT EXISTS record ON TABLE data_check_finding TYPE record;
DEFINE FIELD IF NOT EXISTS field ON TABLE data_check_finding TYPE string;
DEFINE FIELD IF NOT EXISTS category ON TABLE data_check_finding TYPE string ASSERT $value INSIDE ["required", "format"];
DEFINE FIELD IF NOT EXISTS rule_key ON TABLE data_check_finding TYPE string;
DEFINE FIELD IF NOT EXISTS rule_version ON TABLE data_check_finding TYPE string;
DEFINE FIELD IF NOT EXISTS explanation ON TABLE data_check_finding TYPE string;
DEFINE FIELD IF NOT EXISTS evidence_fingerprint ON TABLE data_check_finding TYPE string;
DEFINE FIELD IF NOT EXISTS stable_key ON TABLE data_check_finding TYPE string;
DEFINE FIELD IF NOT EXISTS first_run ON TABLE data_check_finding TYPE record<data_check_run> READONLY;
DEFINE FIELD IF NOT EXISTS last_run ON TABLE data_check_finding TYPE record<data_check_run>;
DEFINE FIELD IF NOT EXISTS run_history ON TABLE data_check_finding TYPE array<record<data_check_run>>;
DEFINE FIELD IF NOT EXISTS occurrences ON TABLE data_check_finding TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS status ON TABLE data_check_finding TYPE string DEFAULT "open" ASSERT $value INSIDE ["open", "resolved", "ignored"];
DEFINE FIELD IF NOT EXISTS created_by ON TABLE data_check_finding TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE data_check_finding TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE data_check_finding TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS data_check_finding_stable_unique ON TABLE data_check_finding COLUMNS stable_key UNIQUE;
