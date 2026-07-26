-- Provider inbox, platform operator authorization, immutable audit and alert delivery.

DEFINE TABLE IF NOT EXISTS provider_event_inbox SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS provider ON TABLE provider_event_inbox TYPE string;
DEFINE FIELD IF NOT EXISTS event_id ON TABLE provider_event_inbox TYPE string;
DEFINE FIELD IF NOT EXISTS event_type ON TABLE provider_event_inbox TYPE string;
DEFINE FIELD IF NOT EXISTS provider_object_id ON TABLE provider_event_inbox TYPE option<string>;
DEFINE FIELD IF NOT EXISTS payload_digest ON TABLE provider_event_inbox TYPE string;
DEFINE FIELD IF NOT EXISTS safe_payload ON TABLE provider_event_inbox TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS signature_verified_at ON TABLE provider_event_inbox TYPE datetime;
DEFINE FIELD IF NOT EXISTS received_at ON TABLE provider_event_inbox TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS retain_until ON TABLE provider_event_inbox TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE provider_event_inbox TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE provider_event_inbox TYPE option<string>;
DEFINE INDEX IF NOT EXISTS provider_event_inbox_unique ON TABLE provider_event_inbox COLUMNS provider, event_id
  UNIQUE;
DEFINE EVENT IF NOT EXISTS provider_event_inbox_immutable ON TABLE provider_event_inbox
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:provider_event_inbox";
  };

DEFINE TABLE IF NOT EXISTS provider_event_state SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS provider_event ON TABLE provider_event_state TYPE record<provider_event_inbox>;
DEFINE FIELD IF NOT EXISTS state ON TABLE provider_event_state TYPE string
  ASSERT $value INSIDE [
    "pending",
    "processing",
    "processed",
    "ignored",
    "stale_ignored",
    "failed",
  ];
DEFINE FIELD IF NOT EXISTS attempt_count ON TABLE provider_event_state TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS next_attempt_at ON TABLE provider_event_state TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE provider_event_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_error_details ON TABLE provider_event_state TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS processed_at ON TABLE provider_event_state TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE provider_event_state TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS provider_event_state_event_unique ON TABLE provider_event_state COLUMNS provider_event
  UNIQUE;

-- Platform operators are unrelated to system_admin (the deployment-wide
-- workspace creation switch) and to workspace/user roles.
DEFINE TABLE IF NOT EXISTS platform_operator SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS subject ON TABLE platform_operator TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE platform_operator TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON TABLE platform_operator TYPE string
  ASSERT $value INSIDE ["active", "disabled"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE platform_operator TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS disabled_at ON TABLE platform_operator TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE platform_operator TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS platform_operator_subject_unique ON TABLE platform_operator COLUMNS subject
  UNIQUE;

DEFINE TABLE IF NOT EXISTS platform_operator_capability SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS operator ON TABLE platform_operator_capability TYPE record<platform_operator>;
DEFINE FIELD IF NOT EXISTS capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read",
    "subscription.manage",
    "override.manage",
    "reconcile.audit",
    "drift.manage",
    "ledger.rebuild",
  ];
DEFINE FIELD IF NOT EXISTS status ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE ["active", "revoked"];
DEFINE FIELD IF NOT EXISTS granted_by_subject ON TABLE platform_operator_capability TYPE string;
DEFINE FIELD IF NOT EXISTS granted_at ON TABLE platform_operator_capability TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS revoked_at ON TABLE platform_operator_capability TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE platform_operator_capability TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS platform_operator_capability_unique ON TABLE platform_operator_capability COLUMNS operator, capability
  UNIQUE;

DEFINE TABLE IF NOT EXISTS quota_operator_intent SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS intent_kind ON TABLE quota_operator_intent TYPE string
  ASSERT $value INSIDE [
    "subscription_upsert",
    "subscription_end",
    "override_schedule",
    "override_end",
    "reconcile_now",
    "audit_now",
    "drift_reapply",
    "drift_to_override",
    "ledger_rebuild",
    "materialization_retry",
    "provisioning_retry",
    "provisioning_cleanup",
    "auto_reconcile_pause",
    "auto_reconcile_resume",
  ];
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_operator_intent TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS billing_account ON TABLE quota_operator_intent TYPE option<record<billing_account>>;
DEFINE FIELD IF NOT EXISTS operator ON TABLE quota_operator_intent TYPE record<platform_operator>;
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE quota_operator_intent TYPE string;
DEFINE FIELD IF NOT EXISTS authorized_capability ON TABLE quota_operator_intent TYPE string;
DEFINE FIELD IF NOT EXISTS request_id ON TABLE quota_operator_intent TYPE string;
DEFINE FIELD IF NOT EXISTS customer_reason ON TABLE quota_operator_intent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS operator_reason ON TABLE quota_operator_intent TYPE string;
DEFINE FIELD IF NOT EXISTS effective_at ON TABLE quota_operator_intent TYPE datetime;
DEFINE FIELD IF NOT EXISTS input ON TABLE quota_operator_intent TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS impact_preview ON TABLE quota_operator_intent TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS before_digest ON TABLE quota_operator_intent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_operator_intent TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_operator_intent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_operator_intent TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS quota_operator_intent_request_unique ON TABLE quota_operator_intent COLUMNS request_id
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_operator_intent_workspace ON TABLE quota_operator_intent COLUMNS workspace;
DEFINE EVENT IF NOT EXISTS quota_operator_intent_immutable ON TABLE quota_operator_intent
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_operator_intent";
  };

DEFINE TABLE IF NOT EXISTS quota_audit_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS event_kind ON TABLE quota_audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_audit_event TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS billing_account ON TABLE quota_audit_event TYPE option<record<billing_account>>;
DEFINE FIELD IF NOT EXISTS provider_event ON TABLE quota_audit_event TYPE option<record<provider_event_inbox>>;
DEFINE FIELD IF NOT EXISTS operator_intent ON TABLE quota_audit_event TYPE option<record<quota_operator_intent>>;
DEFINE FIELD IF NOT EXISTS entitlement_operation ON TABLE quota_audit_event TYPE option<record<entitlement_operation>>;
DEFINE FIELD IF NOT EXISTS materialization_operation ON TABLE quota_audit_event TYPE option<record<quota_materialization_operation>>;
DEFINE FIELD IF NOT EXISTS materialization_attempt ON TABLE quota_audit_event TYPE option<record<quota_materialization_attempt>>;
DEFINE FIELD IF NOT EXISTS actor_kind ON TABLE quota_audit_event TYPE string
  ASSERT $value INSIDE ["system", "provider", "customer", "operator"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS authorized_capability ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reason ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS request_id ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS before_reference ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS after_reference ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS before_digest ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS after_digest ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_details ON TABLE quota_audit_event TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS effective_at ON TABLE quota_audit_event TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS applied_at ON TABLE quota_audit_event TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_audit_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE quota_audit_event TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS quota_audit_event_correlation ON TABLE quota_audit_event COLUMNS correlation_id;
DEFINE INDEX IF NOT EXISTS quota_audit_event_workspace ON TABLE quota_audit_event COLUMNS workspace, occurred_at;
DEFINE EVENT IF NOT EXISTS quota_audit_event_immutable ON TABLE quota_audit_event
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_audit_event";
  };

DEFINE TABLE IF NOT EXISTS quota_alert_state SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_alert_state TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS applied_projection ON TABLE quota_alert_state TYPE record<quota_policy_projection>;
DEFINE FIELD IF NOT EXISTS resource_key ON TABLE quota_alert_state TYPE string;
DEFINE FIELD IF NOT EXISTS table_identity ON TABLE quota_alert_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS threshold_percent ON TABLE quota_alert_state TYPE int
  ASSERT $value INSIDE [80, 90, 100];
DEFINE FIELD IF NOT EXISTS episode ON TABLE quota_alert_state TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS dedupe_key ON TABLE quota_alert_state TYPE string;
DEFINE FIELD IF NOT EXISTS state ON TABLE quota_alert_state TYPE string
  ASSERT $value INSIDE ["armed", "notified", "cleared"];
DEFINE FIELD IF NOT EXISTS used ON TABLE quota_alert_state TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS limit ON TABLE quota_alert_state TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS last_ratio_percent ON TABLE quota_alert_state TYPE number
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS first_observed_at ON TABLE quota_alert_state TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_observed_at ON TABLE quota_alert_state TYPE datetime;
DEFINE FIELD IF NOT EXISTS notified_at ON TABLE quota_alert_state TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS rearmed_at ON TABLE quota_alert_state TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_alert_state TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_alert_state_dedupe_unique ON TABLE quota_alert_state COLUMNS dedupe_key
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_alert_state_workspace ON TABLE quota_alert_state COLUMNS workspace, state;

DEFINE TABLE IF NOT EXISTS quota_notification_outbox SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_notification_outbox TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS billing_account ON TABLE quota_notification_outbox TYPE option<record<billing_account>>;
DEFINE FIELD IF NOT EXISTS alert_state ON TABLE quota_notification_outbox TYPE record<quota_alert_state>;
DEFINE FIELD IF NOT EXISTS audience ON TABLE quota_notification_outbox TYPE string
  ASSERT $value INSIDE ["workspace_admin", "billing_admin", "operator"];
DEFINE FIELD IF NOT EXISTS recipient_subject ON TABLE quota_notification_outbox TYPE option<string>;
DEFINE FIELD IF NOT EXISTS channel ON TABLE quota_notification_outbox TYPE string
  ASSERT $value INSIDE ["in_app"];
DEFINE FIELD IF NOT EXISTS dedupe_key ON TABLE quota_notification_outbox TYPE string;
DEFINE FIELD IF NOT EXISTS payload ON TABLE quota_notification_outbox TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_notification_outbox TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_notification_outbox TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_notification_outbox TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS quota_notification_outbox_dedupe_unique ON TABLE quota_notification_outbox COLUMNS dedupe_key
  UNIQUE;
DEFINE EVENT IF NOT EXISTS quota_notification_outbox_immutable ON TABLE quota_notification_outbox
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_notification_outbox";
  };

DEFINE TABLE IF NOT EXISTS quota_notification_delivery SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS notification ON TABLE quota_notification_delivery TYPE record<quota_notification_outbox>;
DEFINE FIELD IF NOT EXISTS status ON TABLE quota_notification_delivery TYPE string
  ASSERT $value INSIDE ["pending", "delivered", "failed"];
DEFINE FIELD IF NOT EXISTS attempt_count ON TABLE quota_notification_delivery TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS next_attempt_at ON TABLE quota_notification_delivery TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS delivered_at ON TABLE quota_notification_delivery TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE quota_notification_delivery TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_notification_delivery TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_notification_delivery_unique ON TABLE quota_notification_delivery COLUMNS notification
  UNIQUE;
