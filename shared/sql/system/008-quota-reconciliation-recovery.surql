-- Recovery state required by the root-only reconciler and persistent sweeps.

DEFINE FIELD IF NOT EXISTS reconcile_mode ON TABLE quota_materialization_operation TYPE string
  DEFAULT "normal"
  ASSERT $value INSIDE ["normal", "drift_reapply"];
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE quota_materialization_operation TYPE option<datetime>;

DEFINE FIELD IF NOT EXISTS attempt_count ON TABLE quota_sweep_cursor TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS next_attempt_at ON TABLE quota_sweep_cursor TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE quota_sweep_cursor TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_error_retryable ON TABLE quota_sweep_cursor TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS last_error_details ON TABLE quota_sweep_cursor TYPE option<object> FLEXIBLE;
