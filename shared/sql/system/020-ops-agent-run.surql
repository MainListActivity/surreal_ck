-- 外部 agent 仅报告自身最小检查点。业务动作结果仍以对应服务的审计为准。
DEFINE TABLE IF NOT EXISTS ops_agent_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run_key ON TABLE ops_agent_run TYPE string;
DEFINE FIELD IF NOT EXISTS agent_subject ON TABLE ops_agent_run TYPE string;
DEFINE FIELD IF NOT EXISTS workspace_slug ON TABLE ops_agent_run TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE ops_agent_run TYPE string ASSERT $value INSIDE ["running", "waiting", "completed", "needs_human"];
DEFINE FIELD IF NOT EXISTS cursor ON TABLE ops_agent_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS processed_ids ON TABLE ops_agent_run TYPE array<string>;
DEFINE FIELD IF NOT EXISTS pending_action ON TABLE ops_agent_run TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS due_check_at ON TABLE ops_agent_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS retry_count ON TABLE ops_agent_run TYPE int;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE ops_agent_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actions_completed ON TABLE ops_agent_run TYPE int;
DEFINE FIELD IF NOT EXISTS version ON TABLE ops_agent_run TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ops_agent_run TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ops_agent_run_identity ON TABLE ops_agent_run COLUMNS agent_subject, workspace_slug, run_key UNIQUE;
