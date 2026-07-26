-- Immutable entitlement/projection snapshots and recoverable materialization state.

DEFINE TABLE IF NOT EXISTS resource_entitlement SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE resource_entitlement TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE resource_entitlement TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS source_type ON TABLE resource_entitlement TYPE string
  ASSERT $value INSIDE ["paid", "trial", "contract", "manual", "retention"];
DEFINE FIELD IF NOT EXISTS subscription_item ON TABLE resource_entitlement TYPE option<record<quota_subscription_item>>;
DEFINE FIELD IF NOT EXISTS plan_revision ON TABLE resource_entitlement TYPE record<quota_plan_revision>;
DEFINE FIELD IF NOT EXISTS override_revision ON TABLE resource_entitlement TYPE option<record<quota_override_revision>>;
DEFINE FIELD IF NOT EXISTS service_mode ON TABLE resource_entitlement TYPE string
  ASSERT $value INSIDE ["standard", "grace", "retention"];
DEFINE FIELD IF NOT EXISTS rules ON TABLE resource_entitlement TYPE array<object>;
DEFINE FIELD IF NOT EXISTS rules.*.rule_key ON TABLE resource_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.resource ON TABLE resource_entitlement TYPE string
  ASSERT $value INSIDE ["table", "field", "record"];
DEFINE FIELD IF NOT EXISTS rules.*.selector ON TABLE resource_entitlement TYPE object;
DEFINE FIELD IF NOT EXISTS rules.*.selector.kind ON TABLE resource_entitlement TYPE string
  ASSERT $value INSIDE ["exact", "regex"];
DEFINE FIELD IF NOT EXISTS rules.*.selector.value ON TABLE resource_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.limit ON TABLE resource_entitlement TYPE object;
DEFINE FIELD IF NOT EXISTS rules.*.limit.kind ON TABLE resource_entitlement TYPE string
  ASSERT $value INSIDE ["finite", "unlimited"];
DEFINE FIELD IF NOT EXISTS rules.*.limit.value ON TABLE resource_entitlement TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS rules.*.customer_label ON TABLE resource_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.customer_description ON TABLE resource_entitlement TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source_digest ON TABLE resource_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS effective_at ON TABLE resource_entitlement TYPE datetime;
DEFINE FIELD IF NOT EXISTS effective_until ON TABLE resource_entitlement TYPE option<datetime>
  ASSERT $value = NONE
  OR $value > effective_at;
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE resource_entitlement TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE resource_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE resource_entitlement TYPE option<string>;
DEFINE INDEX IF NOT EXISTS resource_entitlement_revision_unique ON TABLE resource_entitlement COLUMNS workspace, revision
  UNIQUE;
DEFINE EVENT IF NOT EXISTS resource_entitlement_immutable ON TABLE resource_entitlement
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:resource_entitlement";
  };

DEFINE TABLE IF NOT EXISTS quota_policy_projection SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_policy_projection TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS entitlement ON TABLE quota_policy_projection TYPE record<resource_entitlement>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE quota_policy_projection TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS compiler_version ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS native_capability ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS native_contract_major ON TABLE quota_policy_projection TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS info_format_version ON TABLE quota_policy_projection TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS rules ON TABLE quota_policy_projection TYPE array<object>;
DEFINE FIELD IF NOT EXISTS rules.*.rule_id ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.rule_key ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.resource ON TABLE quota_policy_projection TYPE string
  ASSERT $value INSIDE ["table", "field", "record"];
DEFINE FIELD IF NOT EXISTS rules.*.selector ON TABLE quota_policy_projection TYPE object;
DEFINE FIELD IF NOT EXISTS rules.*.selector.kind ON TABLE quota_policy_projection TYPE string
  ASSERT $value INSIDE ["exact", "regex"];
DEFINE FIELD IF NOT EXISTS rules.*.selector.value ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.limit ON TABLE quota_policy_projection TYPE object;
DEFINE FIELD IF NOT EXISTS rules.*.limit.kind ON TABLE quota_policy_projection TYPE string
  ASSERT $value INSIDE ["finite", "unlimited"];
DEFINE FIELD IF NOT EXISTS rules.*.limit.value ON TABLE quota_policy_projection TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS canonical_digest ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_policy_projection TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_policy_projection TYPE option<string>;
DEFINE INDEX IF NOT EXISTS quota_policy_projection_revision_unique ON TABLE quota_policy_projection COLUMNS workspace, revision
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_policy_projection_entitlement ON TABLE quota_policy_projection COLUMNS entitlement;
DEFINE EVENT IF NOT EXISTS quota_policy_projection_immutable ON TABLE quota_policy_projection
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_policy_projection";
  };

DEFINE TABLE IF NOT EXISTS entitlement_operation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE entitlement_operation TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS operation_kind ON TABLE entitlement_operation TYPE string
  ASSERT $value INSIDE [
    "provider_update",
    "manual_assignment",
    "trial_transition",
    "plan_rollout",
    "override_change",
    "source_expiry",
    "workspace_provisioning",
    "control_plane_sweep",
  ];
DEFINE FIELD IF NOT EXISTS outcome ON TABLE entitlement_operation TYPE string
  ASSERT $value INSIDE ["succeeded", "failed", "no_change"];
DEFINE FIELD IF NOT EXISTS entitlement ON TABLE entitlement_operation TYPE option<record<resource_entitlement>>;
DEFINE FIELD IF NOT EXISTS projection ON TABLE entitlement_operation TYPE option<record<quota_policy_projection>>;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE entitlement_operation TYPE string;
DEFINE FIELD IF NOT EXISTS request_id ON TABLE entitlement_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actor_kind ON TABLE entitlement_operation TYPE string
  ASSERT $value INSIDE ["system", "provider", "customer", "operator"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE entitlement_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS authorized_capability ON TABLE entitlement_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reason ON TABLE entitlement_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE entitlement_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_details ON TABLE entitlement_operation TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS effective_at ON TABLE entitlement_operation TYPE datetime;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE entitlement_operation TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE entitlement_operation TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE entitlement_operation TYPE option<string>;
DEFINE INDEX IF NOT EXISTS entitlement_operation_idempotency_unique ON TABLE entitlement_operation COLUMNS idempotency_key
  UNIQUE;
DEFINE INDEX IF NOT EXISTS entitlement_operation_request_unique ON TABLE entitlement_operation COLUMNS request_id
  UNIQUE;
DEFINE EVENT IF NOT EXISTS entitlement_operation_immutable ON TABLE entitlement_operation
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:entitlement_operation";
  };

DEFINE TABLE IF NOT EXISTS quota_materialization_operation SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_materialization_operation TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS entitlement ON TABLE quota_materialization_operation TYPE record<resource_entitlement>;
DEFINE FIELD IF NOT EXISTS projection ON TABLE quota_materialization_operation TYPE record<quota_policy_projection>;
DEFINE FIELD IF NOT EXISTS status ON TABLE quota_materialization_operation TYPE string
  ASSERT $value INSIDE [
    "pending",
    "applying",
    "succeeded",
    "failed",
    "superseded",
  ];
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE quota_materialization_operation TYPE string;
DEFINE FIELD IF NOT EXISTS request_id ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS attempt_count ON TABLE quota_materialization_operation TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS next_attempt_at ON TABLE quota_materialization_operation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS first_failed_at ON TABLE quota_materialization_operation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_failed_at ON TABLE quota_materialization_operation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_error_retryable ON TABLE quota_materialization_operation TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS last_error_details ON TABLE quota_materialization_operation TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS lease_owner ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE quota_materialization_operation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE quota_materialization_operation TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS observed_before_generation ON TABLE quota_materialization_operation TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS observed_before_digest ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS native_operation_id ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS applied_native_generation ON TABLE quota_materialization_operation TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS readback_digest ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS applied_at ON TABLE quota_materialization_operation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS superseded_by ON TABLE quota_materialization_operation TYPE option<record<quota_materialization_operation>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_materialization_operation TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_materialization_operation TYPE datetime
  VALUE time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_materialization_operation TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_materialization_operation TYPE option<string>;
DEFINE INDEX IF NOT EXISTS quota_materialization_workspace_projection_unique ON TABLE quota_materialization_operation COLUMNS workspace, projection
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_materialization_idempotency_unique ON TABLE quota_materialization_operation COLUMNS idempotency_key
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_materialization_request_unique ON TABLE quota_materialization_operation COLUMNS request_id
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_materialization_ready ON TABLE quota_materialization_operation COLUMNS status, next_attempt_at;
DEFINE EVENT IF NOT EXISTS quota_materialization_terminal_guard ON TABLE quota_materialization_operation
  WHEN $event = "DELETE"
  OR (
    $event = "UPDATE"
    AND $before.status INSIDE ["succeeded", "superseded"]
  )
  THEN {
    THROW "immutable-terminal-operation:quota_materialization_operation";
  };

DEFINE TABLE IF NOT EXISTS quota_materialization_attempt SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS operation ON TABLE quota_materialization_attempt TYPE record<quota_materialization_operation>;
DEFINE FIELD IF NOT EXISTS attempt_number ON TABLE quota_materialization_attempt TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE quota_materialization_attempt TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS worker_id ON TABLE quota_materialization_attempt TYPE string;
DEFINE FIELD IF NOT EXISTS outcome ON TABLE quota_materialization_attempt TYPE string
  ASSERT $value INSIDE [
    "succeeded",
    "retryable_error",
    "terminal_error",
    "lease_lost",
    "commit_unknown",
    "superseded",
  ];
DEFINE FIELD IF NOT EXISTS observed_before_generation ON TABLE quota_materialization_attempt TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS observed_before_digest ON TABLE quota_materialization_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS native_operation_id ON TABLE quota_materialization_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS observed_after_generation ON TABLE quota_materialization_attempt TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS observed_after_digest ON TABLE quota_materialization_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS ledger_state ON TABLE quota_materialization_attempt TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE ["uninitialized", "rebuilding", "ready", "corrupt"];
DEFINE FIELD IF NOT EXISTS usage_trusted ON TABLE quota_materialization_attempt TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE quota_materialization_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_retryable ON TABLE quota_materialization_attempt TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS error_details ON TABLE quota_materialization_attempt TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE quota_materialization_attempt TYPE datetime;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE quota_materialization_attempt TYPE datetime;
DEFINE FIELD IF NOT EXISTS duration_ms ON TABLE quota_materialization_attempt TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_materialization_attempt TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_materialization_attempt TYPE string;
DEFINE INDEX IF NOT EXISTS quota_materialization_attempt_unique ON TABLE quota_materialization_attempt COLUMNS operation, attempt_number
  UNIQUE;
DEFINE EVENT IF NOT EXISTS quota_materialization_attempt_immutable ON TABLE quota_materialization_attempt
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_materialization_attempt";
  };

-- Existing workspace records gain only pointers. Full immutable snapshots stay
-- in their authority tables and are never copied into the lifecycle record.
DEFINE FIELD IF NOT EXISTS desired_entitlement ON TABLE workspace TYPE option<record<resource_entitlement>>;
DEFINE FIELD IF NOT EXISTS applied_entitlement ON TABLE workspace TYPE option<record<resource_entitlement>>;
DEFINE FIELD IF NOT EXISTS desired_quota_projection ON TABLE workspace TYPE option<record<quota_policy_projection>>;
DEFINE FIELD IF NOT EXISTS applied_quota_projection ON TABLE workspace TYPE option<record<quota_policy_projection>>;
DEFINE FIELD OVERWRITE status ON TABLE workspace TYPE string
  ASSERT $value INSIDE [
    "provisioning",
    "active",
    "provisioning_error",
    "failed",
    "archived",
  ];

DEFINE TABLE IF NOT EXISTS workspace_quota_runtime SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_quota_runtime TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS sync_state ON TABLE workspace_quota_runtime TYPE string
  ASSERT $value INSIDE [
    "pending",
    "applying",
    "in_sync",
    "error",
    "external_drift",
    "paused",
  ];
DEFINE FIELD IF NOT EXISTS service_mode ON TABLE workspace_quota_runtime TYPE string
  ASSERT $value INSIDE ["standard", "grace", "retention"];
DEFINE FIELD IF NOT EXISTS quota_compliance ON TABLE workspace_quota_runtime TYPE string
  ASSERT $value INSIDE ["compliant", "over_limit", "unknown"];
DEFINE FIELD IF NOT EXISTS capacity_state ON TABLE workspace_quota_runtime TYPE string
  ASSERT $value INSIDE [
    "normal",
    "warning",
    "critical",
    "at_limit",
    "over_limit",
    "unknown",
  ];
DEFINE FIELD IF NOT EXISTS auto_reconcile ON TABLE workspace_quota_runtime TYPE bool
  DEFAULT true;
DEFINE FIELD IF NOT EXISTS last_sync_error_code ON TABLE workspace_quota_runtime TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_sync_error_retryable ON TABLE workspace_quota_runtime TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS last_sync_error_details ON TABLE workspace_quota_runtime TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS last_native_audit_at ON TABLE workspace_quota_runtime TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS native_observed_at ON TABLE workspace_quota_runtime TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS native_observed_generation ON TABLE workspace_quota_runtime TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS native_observed_digest ON TABLE workspace_quota_runtime TYPE option<string>;
DEFINE FIELD IF NOT EXISTS ledger_state ON TABLE workspace_quota_runtime TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE ["uninitialized", "rebuilding", "ready", "corrupt"];
DEFINE FIELD IF NOT EXISTS usage_trusted ON TABLE workspace_quota_runtime TYPE bool
  DEFAULT false;
DEFINE FIELD IF NOT EXISTS usage_summary ON TABLE workspace_quota_runtime TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS cache_expires_at ON TABLE workspace_quota_runtime TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_owner ON TABLE workspace_quota_runtime TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE workspace_quota_runtime TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE workspace_quota_runtime TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workspace_quota_runtime TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_quota_runtime_workspace_unique ON TABLE workspace_quota_runtime COLUMNS workspace
  UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_quota_runtime_sync_state ON TABLE workspace_quota_runtime COLUMNS sync_state;

DEFINE TABLE IF NOT EXISTS quota_sweep_cursor SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS sweep_name ON TABLE quota_sweep_cursor TYPE string
  ASSERT $value INSIDE [
    "materialization_worker",
    "control_plane_sweep",
    "native_audit_sweep",
    "provider_reconciliation",
  ];
DEFINE FIELD IF NOT EXISTS cursor ON TABLE quota_sweep_cursor TYPE option<string>;
DEFINE FIELD IF NOT EXISTS epoch ON TABLE quota_sweep_cursor TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS lease_owner ON TABLE quota_sweep_cursor TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE quota_sweep_cursor TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE quota_sweep_cursor TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS last_started_at ON TABLE quota_sweep_cursor TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_completed_at ON TABLE quota_sweep_cursor TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_sweep_cursor TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_sweep_cursor_name_unique ON TABLE quota_sweep_cursor COLUMNS sweep_name
  UNIQUE;
