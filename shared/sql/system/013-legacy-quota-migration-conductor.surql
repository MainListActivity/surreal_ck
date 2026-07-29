-- Durable inventory, approved assignment, cohort, and per-workspace cutover
-- state for the one-time legacy event -> native quota migration conductor.

DEFINE FIELD OVERWRITE quota_migration_state ON TABLE workspace TYPE string
  DEFAULT "not_started"
  ASSERT $value INSIDE [
    "not_started",
    "native_applied",
    "native_policy_active",
    "native_verified",
    "cleanup_done",
  ];

DEFINE TABLE IF NOT EXISTS quota_migration_run SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run_key ON TABLE quota_migration_run TYPE string;
DEFINE FIELD IF NOT EXISTS inventory_checksum ON TABLE quota_migration_run TYPE string;
DEFINE FIELD IF NOT EXISTS manifest_checksum ON TABLE quota_migration_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS state ON TABLE quota_migration_run TYPE string
  ASSERT $value INSIDE [
    "inventory_ready",
    "manifest_importing",
    "assignments_ready",
    "rebuilding",
    "activating",
    "ready_to_reopen",
    "cutover",
    "paused",
    "aborted",
    "native_verified",
    "observing",
    "cleanup_eligible",
    "completed",
    "failed",
  ];
DEFINE FIELD IF NOT EXISTS public_reopen_ready ON TABLE quota_migration_run
  TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS maintenance_evidence ON TABLE quota_migration_run
  TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS current_cohort ON TABLE quota_migration_run
  TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE [
    "synthetic_internal",
    "one_percent",
    "ten_percent",
    "fifty_percent",
    "remainder",
  ];
DEFINE FIELD IF NOT EXISTS paused_from_state ON TABLE quota_migration_run
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS pause_reason ON TABLE quota_migration_run
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS abort_reason ON TABLE quota_migration_run
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS all_native_policy_active_at ON TABLE quota_migration_run
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS all_native_verified_at ON TABLE quota_migration_run
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS full_audit_clean_at ON TABLE quota_migration_run
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS product_release_stable_since ON TABLE quota_migration_run
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS pre_native_compatibility_blocked_at ON TABLE quota_migration_run
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cleanup_not_before ON TABLE quota_migration_run
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_migration_run
  TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_migration_run
  TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_migration_run_key_unique
  ON TABLE quota_migration_run COLUMNS run_key UNIQUE;

DEFINE TABLE IF NOT EXISTS quota_migration_inventory SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run ON TABLE quota_migration_inventory
  TYPE record<quota_migration_run>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_migration_inventory
  TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS workspace_slug ON TABLE quota_migration_inventory
  TYPE string;
DEFINE FIELD IF NOT EXISTS db_name ON TABLE quota_migration_inventory
  TYPE string;
DEFINE FIELD IF NOT EXISTS workspace_status ON TABLE quota_migration_inventory
  TYPE string ASSERT $value INSIDE ["active", "provisioning"];
DEFINE FIELD IF NOT EXISTS snapshot ON TABLE quota_migration_inventory
  TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS checksum ON TABLE quota_migration_inventory
  TYPE string;
DEFINE FIELD IF NOT EXISTS blocking_anomalies ON TABLE quota_migration_inventory
  TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_migration_inventory
  TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS quota_migration_inventory_workspace_unique
  ON TABLE quota_migration_inventory COLUMNS run, workspace UNIQUE;
DEFINE EVENT IF NOT EXISTS quota_migration_inventory_immutable ON TABLE quota_migration_inventory
  WHEN $event = "UPDATE" OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_migration_inventory";
  };

DEFINE TABLE IF NOT EXISTS quota_migration_assignment SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run ON TABLE quota_migration_assignment
  TYPE record<quota_migration_run>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_migration_assignment
  TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS workspace_slug ON TABLE quota_migration_assignment
  TYPE string;
DEFINE FIELD IF NOT EXISTS db_name ON TABLE quota_migration_assignment
  TYPE string;
DEFINE FIELD IF NOT EXISTS billing_account ON TABLE quota_migration_assignment
  TYPE record<billing_account>;
DEFINE FIELD IF NOT EXISTS plan_revision ON TABLE quota_migration_assignment
  TYPE record<quota_plan_revision>;
DEFINE FIELD IF NOT EXISTS source ON TABLE quota_migration_assignment
  TYPE string ASSERT $value INSIDE ["manual", "contract"];
DEFINE FIELD IF NOT EXISTS effective_at ON TABLE quota_migration_assignment
  TYPE datetime;
DEFINE FIELD IF NOT EXISTS rollout_class ON TABLE quota_migration_assignment
  TYPE string ASSERT $value INSIDE ["synthetic", "internal", "standard"];
DEFINE FIELD IF NOT EXISTS cohort ON TABLE quota_migration_assignment
  TYPE string
  ASSERT $value INSIDE [
    "synthetic_internal",
    "one_percent",
    "ten_percent",
    "fifty_percent",
    "remainder",
  ];
DEFINE FIELD IF NOT EXISTS evidence_reference ON TABLE quota_migration_assignment
  TYPE string;
DEFINE FIELD IF NOT EXISTS approved_by_subject ON TABLE quota_migration_assignment
  TYPE string;
DEFINE FIELD IF NOT EXISTS approved_at ON TABLE quota_migration_assignment
  TYPE datetime;
DEFINE FIELD IF NOT EXISTS assignment_checksum ON TABLE quota_migration_assignment
  TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_migration_assignment
  TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS quota_migration_assignment_workspace_unique
  ON TABLE quota_migration_assignment COLUMNS run, workspace UNIQUE;
DEFINE EVENT IF NOT EXISTS quota_migration_assignment_immutable ON TABLE quota_migration_assignment
  WHEN $event = "UPDATE" OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_migration_assignment";
  };

DEFINE TABLE IF NOT EXISTS quota_migration_workspace_operation SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run ON TABLE quota_migration_workspace_operation
  TYPE record<quota_migration_run>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_migration_workspace_operation
  TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS inventory ON TABLE quota_migration_workspace_operation
  TYPE record<quota_migration_inventory>;
DEFINE FIELD IF NOT EXISTS assignment ON TABLE quota_migration_workspace_operation
  TYPE option<record<quota_migration_assignment>>;
DEFINE FIELD IF NOT EXISTS cohort ON TABLE quota_migration_workspace_operation
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS state ON TABLE quota_migration_workspace_operation
  TYPE string
  ASSERT $value INSIDE [
    "inventoried",
    "assignment_approved",
    "rebuilding",
    "rebuild_verified",
    "native_policy_active",
    "cutover_pending",
    "cutover_processing",
    "commit_unknown",
    "native_verified",
    "failed",
    "cleanup_eligible",
    "cleanup_done",
  ];
DEFINE FIELD IF NOT EXISTS attempt_count ON TABLE quota_migration_workspace_operation
  TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS lease_owner ON TABLE quota_migration_workspace_operation
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE quota_migration_workspace_operation
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE quota_migration_workspace_operation
  TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS inventory_event_targets ON TABLE quota_migration_workspace_operation
  TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS observed_native_generation ON TABLE quota_migration_workspace_operation
  TYPE option<int> ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD IF NOT EXISTS observed_native_digest ON TABLE quota_migration_workspace_operation
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS physical_scan_checksum ON TABLE quota_migration_workspace_operation
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS impact_preview ON TABLE quota_migration_workspace_operation
  TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE quota_migration_workspace_operation
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_error_details ON TABLE quota_migration_workspace_operation
  TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS native_policy_active_at ON TABLE quota_migration_workspace_operation
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS native_verified_at ON TABLE quota_migration_workspace_operation
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_migration_workspace_operation
  TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_migration_workspace_operation_unique
  ON TABLE quota_migration_workspace_operation COLUMNS run, workspace UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_migration_workspace_operation_ready
  ON TABLE quota_migration_workspace_operation COLUMNS run, cohort, state;

DEFINE TABLE IF NOT EXISTS quota_migration_cohort SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run ON TABLE quota_migration_cohort
  TYPE record<quota_migration_run>;
DEFINE FIELD IF NOT EXISTS cohort ON TABLE quota_migration_cohort TYPE string
  ASSERT $value INSIDE [
    "synthetic_internal",
    "one_percent",
    "ten_percent",
    "fifty_percent",
    "remainder",
  ];
DEFINE FIELD IF NOT EXISTS ordinal ON TABLE quota_migration_cohort
  TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS state ON TABLE quota_migration_cohort TYPE string
  ASSERT $value INSIDE [
    "pending",
    "active",
    "observing",
    "complete",
    "paused",
    "aborted",
  ];
DEFINE FIELD IF NOT EXISTS required_observation_hours ON TABLE quota_migration_cohort
  TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE quota_migration_cohort
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS observe_until ON TABLE quota_migration_cohort
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE quota_migration_cohort
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_migration_cohort
  TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_migration_cohort_unique
  ON TABLE quota_migration_cohort COLUMNS run, cohort UNIQUE;

DEFINE TABLE IF NOT EXISTS quota_migration_signal SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS run ON TABLE quota_migration_signal
  TYPE record<quota_migration_run>;
DEFINE FIELD IF NOT EXISTS cohort ON TABLE quota_migration_signal
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_migration_signal
  TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS signal_kind ON TABLE quota_migration_signal TYPE string
  ASSERT $value INSIDE [
    "false_negative",
    "counter_mismatch",
    "ledger_corrupt",
    "structured_error_lost",
    "unknown_drift",
    "cross_workspace_leak",
    "recovery_failed",
    "unexpected_denial",
    "performance_regression",
  ];
DEFINE FIELD IF NOT EXISTS blocking ON TABLE quota_migration_signal
  TYPE bool;
DEFINE FIELD IF NOT EXISTS details ON TABLE quota_migration_signal
  TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS checksum ON TABLE quota_migration_signal
  TYPE string;
DEFINE FIELD IF NOT EXISTS observed_at ON TABLE quota_migration_signal
  TYPE datetime;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_migration_signal
  TYPE datetime DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS quota_migration_signal_immutable ON TABLE quota_migration_signal
  WHEN $event = "UPDATE" OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_migration_signal";
  };
