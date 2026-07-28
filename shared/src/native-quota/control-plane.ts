import type { DateTime, StringRecordId } from "surrealdb";
import type {
  NativeQuotaLimit,
  NativeQuotaResource,
  NativeQuotaSelector,
} from "./contracts";

export type SurrealInteger = number | bigint;
export type ControlPlaneObject = Readonly<Record<string, unknown>>;

export type BillingAccountKind = "personal" | "team" | "enterprise";
export type BillingAccountStatus = "active" | "closed";
export type BillingAccountMemberRole = "owner" | "admin" | "viewer";
export type BillingAccountMemberStatus = "active" | "revoked";
export type QuotaPlanVisibility = "public" | "internal";
export type QuotaPlanStatus = "active" | "retired";
export type QuotaPlanTemplateKind =
  | "commercial"
  | "trial"
  | "contract"
  | "retention";
export type QuotaSubscriptionSource = "provider" | "manual" | "contract";
export type QuotaSubscriptionStatus =
  | "pending"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled"
  | "expired";
export type QuotaSubscriptionItemStatus = "scheduled" | "active" | "ended";
export type QuotaServiceMode = "standard" | "grace" | "retention";
export type QuotaSyncState =
  | "pending"
  | "applying"
  | "in_sync"
  | "error"
  | "external_drift"
  | "paused";
export type QuotaCompliance = "compliant" | "over_limit" | "unknown";
export type QuotaCapacityState =
  | "normal"
  | "warning"
  | "critical"
  | "at_limit"
  | "over_limit"
  | "unknown";

export type ProductQuotaRule = Readonly<{
  rule_key: string;
  resource: NativeQuotaResource;
  selector: Readonly<{
    kind: NativeQuotaSelector["kind"];
    value: string;
  }>;
  limit: NativeQuotaLimit;
  customer_label: string;
  customer_description?: string;
}>;

export type CompiledQuotaRule = Readonly<{
  rule_id: string;
  resource: NativeQuotaResource;
  selector: NativeQuotaSelector;
  limit: NativeQuotaLimit;
}>;

export type CompiledQuotaRuleLabel = Readonly<{
  rule_id: string;
  rule_key: string;
  resource: NativeQuotaResource;
  customer_label: string;
  customer_description?: string;
}>;

export type QuotaOverridePatch = Readonly<{
  rule_key: string;
  action: "replace" | "disable";
  selector?: Readonly<{
    kind?: NativeQuotaSelector["kind"];
    value?: string;
  }>;
  limit?: NativeQuotaLimit;
}>;

export type BillingAccountRecord = {
  id: StringRecordId;
  account_key: string;
  name: string;
  kind: BillingAccountKind;
  status: BillingAccountStatus;
  created_at: DateTime;
  updated_at: DateTime;
  closed_at?: DateTime;
};

export type BillingAccountMemberRecord = {
  id: StringRecordId;
  billing_account: StringRecordId;
  subject: string;
  role: BillingAccountMemberRole;
  status: BillingAccountMemberStatus;
  joined_at: DateTime;
  revoked_at?: DateTime;
  updated_at: DateTime;
};

export type QuotaPlanRecord = {
  id: StringRecordId;
  plan_key: string;
  display_name: string;
  visibility: QuotaPlanVisibility;
  status: QuotaPlanStatus;
  active_revision?: StringRecordId;
  created_at: DateTime;
  updated_at: DateTime;
};

export type QuotaPlanRevisionRecord = Readonly<{
  id: StringRecordId;
  plan: StringRecordId;
  revision: SurrealInteger;
  template_kind: QuotaPlanTemplateKind;
  rules: readonly ProductQuotaRule[];
  created_by_subject: string;
  created_at: DateTime;
  published_at: DateTime;
  correlation_id: string;
  causation_id?: string;
}>;

export type QuotaSubscriptionRecord = {
  id: StringRecordId;
  billing_account: StringRecordId;
  source: QuotaSubscriptionSource;
  status: QuotaSubscriptionStatus;
  revision: SurrealInteger;
  provider?: string;
  provider_customer_id?: string;
  provider_subscription_id?: string;
  provider_source_revision?: SurrealInteger;
  current_period_start?: DateTime;
  current_period_end?: DateTime;
  trial_start?: DateTime;
  trial_end?: DateTime;
  paid_through?: DateTime;
  grace_until?: DateTime;
  cancel_at_period_end: boolean;
  cancel_at?: DateTime;
  canceled_at?: DateTime;
  expires_at?: DateTime;
  created_at: DateTime;
  updated_at: DateTime;
  correlation_id: string;
  causation_id?: string;
};

export type QuotaSubscriptionItemRecord = {
  id: StringRecordId;
  subscription: StringRecordId;
  workspace: StringRecordId;
  plan_revision: StringRecordId;
  revision: SurrealInteger;
  status: QuotaSubscriptionItemStatus;
  effective_from: DateTime;
  effective_until?: DateTime;
  active_workspace?: StringRecordId;
  scheduled_workspace?: StringRecordId;
  ended_reason?: string;
  created_at: DateTime;
  updated_at: DateTime;
  correlation_id: string;
  causation_id?: string;
};

export type QuotaOverrideRevisionRecord = Readonly<{
  id: StringRecordId;
  workspace: StringRecordId;
  revision: SurrealInteger;
  previous_revision?: StringRecordId;
  patches: readonly QuotaOverridePatch[];
  customer_reason: string;
  operator_reason: string;
  created_by_subject: string;
  authorized_capability: string;
  effective_at: DateTime;
  expires_at?: DateTime;
  request_id: string;
  correlation_id: string;
  causation_id?: string;
  created_at: DateTime;
}>;

export type WorkspaceQuotaOverrideRecord = {
  id: StringRecordId;
  workspace: StringRecordId;
  active_revision?: StringRecordId;
  scheduled_revision?: StringRecordId;
  updated_at: DateTime;
};

export type ResourceEntitlementSourceType =
  | "paid"
  | "trial"
  | "contract"
  | "manual"
  | "retention";

export type ResourceEntitlementRecord = Readonly<{
  id: StringRecordId;
  workspace: StringRecordId;
  revision: SurrealInteger;
  source_type: ResourceEntitlementSourceType;
  subscription_item?: StringRecordId;
  plan_revision: StringRecordId;
  override_revision?: StringRecordId;
  service_mode: QuotaServiceMode;
  rules: readonly ProductQuotaRule[];
  source_digest: string;
  effective_at: DateTime;
  effective_until?: DateTime;
  resolved_at: DateTime;
  correlation_id: string;
  causation_id?: string;
}>;

export type QuotaPolicyProjectionRecord = Readonly<{
  id: StringRecordId;
  workspace: StringRecordId;
  entitlement: StringRecordId;
  revision: SurrealInteger;
  compiler_version: string;
  native_capability: string;
  native_contract_major: SurrealInteger;
  info_format_version: SurrealInteger;
  rules: readonly CompiledQuotaRule[];
  rule_labels: readonly CompiledQuotaRuleLabel[];
  canonical_digest: string;
  created_at: DateTime;
  correlation_id: string;
  causation_id?: string;
}>;

export type EntitlementOperationKind =
  | "provider_update"
  | "manual_assignment"
  | "trial_transition"
  | "plan_rollout"
  | "override_change"
  | "source_expiry"
  | "workspace_provisioning"
  | "control_plane_sweep";

export type EntitlementOperationRecord = Readonly<{
  id: StringRecordId;
  workspace: StringRecordId;
  operation_kind: EntitlementOperationKind;
  outcome: "succeeded" | "failed" | "no_change";
  entitlement?: StringRecordId;
  projection?: StringRecordId;
  idempotency_key: string;
  request_id?: string;
  actor_kind: "system" | "provider" | "customer" | "operator";
  actor_subject?: string;
  authorized_capability?: string;
  reason?: string;
  error_code?: string;
  error_details?: ControlPlaneObject;
  effective_at: DateTime;
  completed_at: DateTime;
  correlation_id: string;
  causation_id?: string;
}>;

export type QuotaMaterializationStatus =
  | "pending"
  | "applying"
  | "succeeded"
  | "failed"
  | "superseded";

export type QuotaMaterializationOperationRecord = {
  id: StringRecordId;
  workspace: StringRecordId;
  entitlement: StringRecordId;
  projection: StringRecordId;
  status: QuotaMaterializationStatus;
  idempotency_key: string;
  request_id?: string;
  reconcile_mode: "normal" | "drift_reapply";
  attempt_count: SurrealInteger;
  next_attempt_at?: DateTime;
  first_failed_at?: DateTime;
  last_failed_at?: DateTime;
  last_error_code?: string;
  last_error_retryable?: boolean;
  last_error_details?: ControlPlaneObject;
  lease_owner?: string;
  lease_expires_at?: DateTime;
  fencing_token: SurrealInteger;
  observed_before_generation?: SurrealInteger;
  observed_before_digest?: string;
  native_operation_id?: string;
  applied_native_generation?: SurrealInteger;
  readback_digest?: string;
  applied_at?: DateTime;
  completed_at?: DateTime;
  superseded_by?: StringRecordId;
  created_at: DateTime;
  updated_at: DateTime;
  correlation_id: string;
  causation_id?: string;
};

export type QuotaMaterializationAttemptOutcome =
  | "succeeded"
  | "retryable_error"
  | "terminal_error"
  | "lease_lost"
  | "commit_unknown"
  | "superseded";

export type QuotaMaterializationAttemptRecord = Readonly<{
  id: StringRecordId;
  operation: StringRecordId;
  attempt_number: SurrealInteger;
  fencing_token: SurrealInteger;
  worker_id: string;
  outcome: QuotaMaterializationAttemptOutcome;
  observed_before_generation?: SurrealInteger;
  observed_before_digest?: string;
  native_operation_id?: string;
  observed_after_generation?: SurrealInteger;
  observed_after_digest?: string;
  ledger_state?: "uninitialized" | "rebuilding" | "ready" | "corrupt";
  usage_trusted?: boolean;
  error_code?: string;
  error_retryable?: boolean;
  error_details?: ControlPlaneObject;
  started_at: DateTime;
  completed_at: DateTime;
  duration_ms: SurrealInteger;
  correlation_id: string;
  causation_id: string;
}>;

export type WorkspaceQuotaPointers = {
  desired_entitlement?: StringRecordId;
  applied_entitlement?: StringRecordId;
  desired_quota_projection?: StringRecordId;
  applied_quota_projection?: StringRecordId;
};

export type WorkspaceQuotaRuntimeRecord = {
  id: StringRecordId;
  workspace: StringRecordId;
  sync_state: QuotaSyncState;
  service_mode: QuotaServiceMode;
  quota_compliance: QuotaCompliance;
  capacity_state: QuotaCapacityState;
  auto_reconcile: boolean;
  last_sync_error_code?: string;
  last_sync_error_retryable?: boolean;
  last_sync_error_details?: ControlPlaneObject;
  last_native_audit_at?: DateTime;
  native_observed_at?: DateTime;
  native_observed_generation?: SurrealInteger;
  native_observed_digest?: string;
  ledger_state?: "uninitialized" | "rebuilding" | "ready" | "corrupt";
  usage_trusted: boolean;
  usage_summary?: ControlPlaneObject;
  cache_expires_at?: DateTime;
  lease_owner?: string;
  lease_expires_at?: DateTime;
  fencing_token: SurrealInteger;
  updated_at: DateTime;
};

export type QuotaSweepName =
  | "materialization_worker"
  | "control_plane_sweep"
  | "native_audit_sweep"
  | "provider_reconciliation";

export type QuotaSweepCursorRecord = {
  id: StringRecordId;
  sweep_name: QuotaSweepName;
  cursor?: string;
  epoch: SurrealInteger;
  lease_owner?: string;
  lease_expires_at?: DateTime;
  fencing_token: SurrealInteger;
  attempt_count: SurrealInteger;
  next_attempt_at?: DateTime;
  last_error_code?: string;
  last_error_retryable?: boolean;
  last_error_details?: ControlPlaneObject;
  last_started_at?: DateTime;
  last_completed_at?: DateTime;
  updated_at: DateTime;
};

export type ProviderEventInboxRecord = Readonly<{
  id: StringRecordId;
  provider: string;
  event_id: string;
  event_type: string;
  provider_object_id?: string;
  payload_digest: string;
  safe_payload: ControlPlaneObject;
  signature_verified_at: DateTime;
  received_at: DateTime;
  retain_until?: DateTime;
  correlation_id: string;
  causation_id?: string;
}>;

export type ProviderEventStateRecord = {
  id: StringRecordId;
  provider_event: StringRecordId;
  state: "pending" | "processing" | "processed" | "ignored" | "stale_ignored" | "failed";
  attempt_count: SurrealInteger;
  next_attempt_at?: DateTime;
  last_error_code?: string;
  last_error_details?: ControlPlaneObject;
  lease_owner?: string;
  lease_expires_at?: DateTime;
  fencing_token: SurrealInteger;
  applied_subscription?: StringRecordId;
  applied_provider_revision?: SurrealInteger;
  processed_at?: DateTime;
  updated_at: DateTime;
};

export const PLATFORM_OPERATOR_CAPABILITIES = [
  "quota.read",
  "subscription.manage",
  "override.manage",
  "reconcile.audit",
  "drift.manage",
  "ledger.rebuild",
] as const;
export type PlatformOperatorCapability =
  (typeof PLATFORM_OPERATOR_CAPABILITIES)[number];

export type PlatformOperatorRecord = {
  id: StringRecordId;
  subject: string;
  display_name?: string;
  status: "active" | "disabled";
  created_at: DateTime;
  disabled_at?: DateTime;
  updated_at: DateTime;
};

export type PlatformOperatorCapabilityRecord = {
  id: StringRecordId;
  operator: StringRecordId;
  capability: PlatformOperatorCapability;
  status: "active" | "revoked";
  granted_by_subject: string;
  granted_at: DateTime;
  revoked_at?: DateTime;
  updated_at: DateTime;
};

export type QuotaOperatorIntentKind =
  | "subscription_upsert"
  | "subscription_end"
  | "override_schedule"
  | "override_end"
  | "reconcile_now"
  | "audit_now"
  | "drift_reapply"
  | "drift_to_override"
  | "ledger_rebuild"
  | "materialization_retry"
  | "provisioning_retry"
  | "provisioning_cleanup"
  | "auto_reconcile_pause"
  | "auto_reconcile_resume";

export type QuotaOperatorIntentRecord = Readonly<{
  id: StringRecordId;
  intent_kind: QuotaOperatorIntentKind;
  workspace?: StringRecordId;
  billing_account?: StringRecordId;
  operator: StringRecordId;
  actor_subject: string;
  authorized_capability: PlatformOperatorCapability;
  request_id: string;
  customer_reason?: string;
  operator_reason: string;
  effective_at: DateTime;
  input: ControlPlaneObject;
  input_digest?: string;
  impact_preview?: ControlPlaneObject;
  before_digest?: string;
  correlation_id: string;
  causation_id?: string;
  created_at: DateTime;
}>;

export type QuotaOperatorIntentStateRecord = {
  id: StringRecordId;
  intent: StringRecordId;
  state:
    | "scheduled"
    | "pending"
    | "processing"
    | "processed"
    | "failed"
    | "terminal_failed";
  attempt_count: SurrealInteger;
  next_attempt_at?: DateTime;
  lease_owner?: string;
  lease_expires_at?: DateTime;
  fencing_token: SurrealInteger;
  entitlement_operation?: StringRecordId;
  materialization_operation?: StringRecordId;
  affected_workspaces: StringRecordId[];
  last_error_code?: string;
  last_error_details?: ControlPlaneObject;
  processed_at?: DateTime;
  updated_at: DateTime;
};

export type QuotaAuditEventRecord = Readonly<{
  id: StringRecordId;
  event_kind: string;
  workspace?: StringRecordId;
  billing_account?: StringRecordId;
  provider_event?: StringRecordId;
  operator_intent?: StringRecordId;
  entitlement_operation?: StringRecordId;
  materialization_operation?: StringRecordId;
  materialization_attempt?: StringRecordId;
  actor_kind: "system" | "provider" | "customer" | "operator";
  actor_subject?: string;
  authorized_capability?: PlatformOperatorCapability;
  reason?: string;
  request_id?: string;
  before_reference?: string;
  after_reference?: string;
  before_digest?: string;
  after_digest?: string;
  error_code?: string;
  error_details?: ControlPlaneObject;
  effective_at?: DateTime;
  applied_at?: DateTime;
  correlation_id: string;
  causation_id?: string;
  occurred_at: DateTime;
}>;

export type QuotaAlertStateRecord = {
  id: StringRecordId;
  workspace: StringRecordId;
  applied_projection: StringRecordId;
  resource_key: string;
  table_identity?: string;
  threshold_percent: 80 | 90 | 100;
  episode: SurrealInteger;
  dedupe_key: string;
  state: "armed" | "notified" | "cleared";
  used: SurrealInteger;
  limit: SurrealInteger;
  last_ratio_percent: number;
  first_observed_at: DateTime;
  last_observed_at: DateTime;
  notified_at?: DateTime;
  rearmed_at?: DateTime;
  updated_at: DateTime;
};

export type QuotaNotificationOutboxRecord = Readonly<{
  id: StringRecordId;
  workspace: StringRecordId;
  billing_account?: StringRecordId;
  alert_state: StringRecordId;
  audience: "workspace_admin" | "billing_admin" | "operator";
  recipient_subject?: string;
  channel: "in_app";
  dedupe_key: string;
  payload: ControlPlaneObject;
  correlation_id: string;
  causation_id: string;
  created_at: DateTime;
}>;

export type QuotaNotificationDeliveryRecord = {
  id: StringRecordId;
  notification: StringRecordId;
  status: "pending" | "delivered" | "failed";
  attempt_count: SurrealInteger;
  next_attempt_at?: DateTime;
  delivered_at?: DateTime;
  last_error_code?: string;
  updated_at: DateTime;
};
