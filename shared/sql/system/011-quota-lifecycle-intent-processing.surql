-- Durable processing state for normalized provider lifecycle events and
-- asynchronous operator intents. Immutable inbox/intent rows remain the audit
-- source; mutable state rows carry only leases, retries, and result pointers.

DEFINE FIELD IF NOT EXISTS scheduled_workspace ON TABLE quota_subscription_item
  TYPE option<record<workspace>>
  VALUE IF status = "scheduled" THEN workspace ELSE NONE END;
DEFINE INDEX IF NOT EXISTS quota_subscription_item_scheduled_workspace_unique
  ON TABLE quota_subscription_item COLUMNS scheduled_workspace UNIQUE;

DEFINE FIELD IF NOT EXISTS input_digest ON TABLE quota_operator_intent
  TYPE option<string>;

DEFINE FIELD IF NOT EXISTS lease_owner ON TABLE provider_event_state
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE provider_event_state
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE provider_event_state
  TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS applied_subscription ON TABLE provider_event_state
  TYPE option<record<quota_subscription>>;
DEFINE FIELD IF NOT EXISTS applied_provider_revision ON TABLE provider_event_state
  TYPE option<int> ASSERT $value = NONE OR $value >= 0;

DEFINE TABLE IF NOT EXISTS quota_operator_intent_state SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS intent ON TABLE quota_operator_intent_state
  TYPE record<quota_operator_intent>;
DEFINE FIELD IF NOT EXISTS state ON TABLE quota_operator_intent_state
  TYPE string
  ASSERT $value INSIDE [
    "scheduled",
    "pending",
    "processing",
    "processed",
    "failed",
    "terminal_failed",
  ];
DEFINE FIELD IF NOT EXISTS attempt_count ON TABLE quota_operator_intent_state
  TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS next_attempt_at ON TABLE quota_operator_intent_state
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_owner ON TABLE quota_operator_intent_state
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE quota_operator_intent_state
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fencing_token ON TABLE quota_operator_intent_state
  TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS entitlement_operation ON TABLE quota_operator_intent_state
  TYPE option<record<entitlement_operation>>;
DEFINE FIELD IF NOT EXISTS materialization_operation ON TABLE quota_operator_intent_state
  TYPE option<record<quota_materialization_operation>>;
DEFINE FIELD IF NOT EXISTS affected_workspaces ON TABLE quota_operator_intent_state
  TYPE array<record<workspace>>
  DEFAULT [];
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE quota_operator_intent_state
  TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_error_details ON TABLE quota_operator_intent_state
  TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS processed_at ON TABLE quota_operator_intent_state
  TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_operator_intent_state
  TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_operator_intent_state_intent_unique
  ON TABLE quota_operator_intent_state COLUMNS intent UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_operator_intent_state_ready
  ON TABLE quota_operator_intent_state COLUMNS state, next_attempt_at;
