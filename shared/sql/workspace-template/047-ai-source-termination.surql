-- 正常生命周期的来源终止审计；不回填既有桶。
DEFINE TABLE IF NOT EXISTS ai_allowance_source_termination SCHEMAFULL
  PERMISSIONS FOR select WHERE fn::current_user() != NONE, FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS source_prefix ON ai_allowance_source_termination TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS terminated_at ON ai_allowance_source_termination TYPE datetime READONLY;
DEFINE FIELD IF NOT EXISTS paid_source ON ai_allowance_source_termination TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS event_key ON ai_allowance_source_termination TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS note ON ai_allowance_source_termination TYPE string READONLY;
DEFINE INDEX IF NOT EXISTS ai_source_termination_unique ON ai_allowance_source_termination FIELDS source_prefix UNIQUE;
DEFINE EVENT OVERWRITE ai_late_trial_bucket ON ai_allowance_bucket
  WHEN $event = "CREATE" AND $after.kind = "plan_cycle"
  THEN {
    LET $termination = (SELECT * FROM ai_allowance_source_termination
      WHERE string::starts_with($after.period_key, source_prefix) LIMIT 1)[0];
    IF $termination != NONE {
      UPDATE $after.id SET terminated_at = $termination.terminated_at,
        terminated_note = $termination.note;
    };
  };
