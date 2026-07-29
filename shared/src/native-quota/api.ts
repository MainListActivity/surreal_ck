import type {
  PlatformOperatorCapability,
  QuotaOperatorIntentKind,
  QuotaCapacityState,
  QuotaCompliance,
  QuotaServiceMode,
  QuotaSubscriptionStatus,
  QuotaSyncState,
} from "./control-plane";
import type { NativeQuotaResource } from "./contracts";

export const QUOTA_API_FORMAT_VERSION = 1 as const;

export type QuotaApiCapability =
  | "workspace_quota.read"
  | "billing_quota.read"
  | "quota.read";

export type QuotaApiCount = number | string;

export type QuotaApiFiniteUsage = Readonly<{
  kind: "finite";
  limit: QuotaApiCount;
  used: QuotaApiCount | null;
  remaining: QuotaApiCount | null;
  over_by: QuotaApiCount | null;
  utilization_percent: number | null;
  at_limit: boolean | null;
  over_limit: boolean | null;
}>;

export type QuotaApiUnlimitedUsage = Readonly<{
  kind: "unlimited";
  used: QuotaApiCount | null;
  utilization_percent: null;
  at_limit: false;
  over_limit: false;
}>;

export type QuotaApiUsage = QuotaApiFiniteUsage | QuotaApiUnlimitedUsage;

export type QuotaApiResource = Readonly<{
  key: string;
  resource: NativeQuotaResource;
  label: string;
  description?: string;
  selector: Readonly<
    | {
        kind: "exact";
        description: string;
        table?: string;
      }
    | {
        kind: "regex";
        description: string;
        pattern?: string;
        matched_tables?: readonly string[];
      }
  >;
  usage: QuotaApiUsage;
}>;

export type QuotaApiEntitlementSummary = Readonly<{
  source: "paid" | "trial" | "contract" | "manual" | "retention";
  plan_key: string;
  plan_name: string;
  plan_revision: number | string;
  entitlement_revision: number | string;
  effective_at: string;
  effective_until: string | null;
  adjustment: string | null;
}>;

export type QuotaApiStatuses = Readonly<{
  sync: QuotaSyncState;
  compliance: QuotaCompliance;
  capacity: QuotaCapacityState;
  service_mode: QuotaServiceMode;
  ledger: "uninitialized" | "rebuilding" | "ready" | "corrupt" | null;
}>;

export type QuotaApiWorkspace = Readonly<{
  id: string;
  slug: string;
  name: string;
}>;

export type QuotaApiCustomerView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  view: "workspace_admin";
  viewer: Readonly<{
    subject: string;
    capabilities: readonly QuotaApiCapability[];
  }>;
  workspace: QuotaApiWorkspace;
  statuses: QuotaApiStatuses;
  observed_at: string | null;
  commercial_state_at: string;
  cache_age_ms: number | null;
  usage_trusted: boolean;
  stale: boolean;
  applied: QuotaApiEntitlementSummary | null;
  desired: QuotaApiEntitlementSummary | null;
  billing_account: Readonly<{
    account_key: string;
    name: string;
    subscription: QuotaApiSubscriptionLifecycle;
  }> | null;
  resources: readonly QuotaApiResource[];
  actions: readonly ("refresh" | "contact_workspace_admin")[];
}>;

export type QuotaApiParticipantView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  view: "participant";
  viewer: Readonly<{
    subject: string;
    capabilities: readonly [];
  }>;
  workspace: QuotaApiWorkspace;
  actions: readonly ["contact_workspace_admin"];
}>;

export type QuotaApiBillingWorkspaceSummary = Readonly<{
  workspace: QuotaApiWorkspace;
  plan_key: string | null;
  plan_name: string | null;
  plan_revision: number | string | null;
  subscription_status: QuotaSubscriptionStatus | null;
  subscription: QuotaApiSubscriptionLifecycle | null;
  statuses: QuotaApiStatuses;
  utilization: Readonly<{
    capacity: QuotaCapacityState;
    highest_percent: number | null;
    usage_trusted: boolean;
    stale: boolean;
  }>;
}>;

export type QuotaApiSubscriptionLifecycle = Readonly<{
  id: string;
  source: "provider" | "manual" | "contract";
  status: QuotaSubscriptionStatus;
  current_period_end: string | null;
  paid_through: string | null;
  grace_until: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
}>;

export type QuotaApiBillingWorkspaceView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  view: "billing_admin";
  viewer: Readonly<{
    subject: string;
    capabilities: readonly ["billing_quota.read"];
  }>;
  workspace: QuotaApiWorkspace;
  plan_key: string | null;
  plan_name: string | null;
  plan_revision: number | string | null;
  subscription_status: QuotaSubscriptionStatus | null;
  subscription: QuotaApiSubscriptionLifecycle | null;
  statuses: QuotaApiStatuses;
  utilization: Readonly<{
    capacity: QuotaCapacityState;
    highest_percent: number | null;
    usage_trusted: boolean;
    stale: boolean;
  }>;
  observed_at: string | null;
  commercial_state_at: string;
  cache_age_ms: number | null;
  actions: readonly ["refresh"];
}>;

export type QuotaApiBillingView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  view: "billing_admin";
  viewer: Readonly<{
    subject: string;
    capabilities: readonly ["billing_quota.read"];
  }>;
  billing_account: Readonly<{
    account_key: string;
    name: string;
  }>;
  workspaces: readonly QuotaApiBillingWorkspaceSummary[];
  observed_at: string;
  actions: readonly ["refresh"];
}>;

export type QuotaApiOperatorView = Omit<QuotaApiCustomerView, "view"> &
  Readonly<{
    view: "operator";
    viewer: Readonly<{
      subject: string;
      capabilities: readonly QuotaApiCapability[];
    }>;
    operator: Readonly<{
      capabilities: readonly PlatformOperatorCapability[];
      workspace_record: string;
      database: string;
      billing_account_record: string | null;
      billing_account_key: string | null;
      current_subscription: string | null;
      desired_entitlement: string | null;
      applied_entitlement: string | null;
      desired_projection: string | null;
      applied_projection: string | null;
      native_generation: number | string | null;
      native_digest: string | null;
      drift_error_code: string | null;
      auto_reconcile: boolean;
    }>;
  }>;

export type QuotaApiWorkspaceView =
  | QuotaApiCustomerView
  | QuotaApiBillingWorkspaceView
  | QuotaApiParticipantView
  | QuotaApiOperatorView;

export type QuotaInAppNotification = Readonly<{
  id: string;
  workspace: QuotaApiWorkspace;
  kind: "threshold" | "over_limit";
  threshold_percent: 80 | 90 | 100;
  resource_key: string;
  label: string;
  table: string | null;
  used: QuotaApiCount;
  limit: QuotaApiCount;
  created_at: string;
  read_at: string | null;
}>;

export type QuotaOperatorIntentStatusView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  id: string;
  kind: QuotaOperatorIntentKind;
  state:
    | "scheduled"
    | "pending"
    | "processing"
    | "processed"
    | "failed"
    | "terminal_failed";
  attempt_count: number | string;
  next_attempt_at: string | null;
  processed_at: string | null;
  last_error_code: string | null;
  affected_workspaces: readonly string[];
  updated_at: string;
}>;

export type QuotaOpsPlanRule = Readonly<{
  rule_key: string;
  resource: NativeQuotaResource;
  label: string;
  description: string | null;
  selector: Readonly<{
    kind: "exact" | "regex";
    value: string;
  }>;
  limit: Readonly<
    | { kind: "finite"; value: QuotaApiCount }
    | { kind: "unlimited" }
  >;
}>;

export type QuotaOpsPlanRevision = Readonly<{
  id: string;
  plan_key: string;
  plan_name: string;
  revision: QuotaApiCount;
  template_kind: "commercial" | "trial" | "retention" | "contract";
  published_at: string;
  rules: readonly QuotaOpsPlanRule[];
}>;

export type QuotaOpsContextView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  viewer: Readonly<{
    subject: string;
    capabilities: readonly PlatformOperatorCapability[];
  }>;
  plans: readonly QuotaOpsPlanRevision[];
}>;

export type QuotaOpsSearchResult =
  | Readonly<{
      kind: "workspace";
      workspace: QuotaApiWorkspace;
      billing_account: Readonly<{
        id: string;
        account_key: string;
        name: string;
      }> | null;
      applied_plan_name: string | null;
      sync: QuotaSyncState;
      capacity: QuotaCapacityState;
    }>
  | Readonly<{
      kind: "billing_account";
      billing_account: Readonly<{
        id: string;
        account_key: string;
        name: string;
      }>;
      workspace_count: QuotaApiCount;
      workspace_slugs: readonly string[];
    }>
  | Readonly<{
      kind: "subject";
      subject: string;
      workspace_slugs: readonly string[];
      billing_account_keys: readonly string[];
    }>;

export type QuotaOpsSearchView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  viewer: Readonly<{
    subject: string;
    capabilities: readonly PlatformOperatorCapability[];
  }>;
  query: string;
  results: readonly QuotaOpsSearchResult[];
}>;

export type QuotaOpsTimelineItem = Readonly<{
  id: string;
  kind:
    | "operator_intent"
    | "entitlement_operation"
    | "materialization_operation"
    | "materialization_attempt"
    | "audit";
  label: string;
  state: string;
  occurred_at: string;
  actor_subject: string | null;
  authorized_capability: PlatformOperatorCapability | null;
  request_id: string | null;
  correlation_id: string;
  error_code: string | null;
}>;

export type QuotaOpsTimelineView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  workspace: QuotaApiWorkspace;
  items: readonly QuotaOpsTimelineItem[];
}>;

export type QuotaOpsImpactResource = Readonly<{
  key: string;
  label: string;
  resource: NativeQuotaResource;
  selector: string;
  current_limit: QuotaApiCount | "unlimited" | null;
  target_limit: QuotaApiCount | "unlimited" | null;
  used: QuotaApiCount | null;
  projected_over_by: QuotaApiCount | null;
}>;

export type QuotaOpsIntentPreflightView = Readonly<{
  format_version: typeof QUOTA_API_FORMAT_VERSION;
  workspace: QuotaApiWorkspace;
  kind: QuotaOperatorIntentKind;
  required_capability: PlatformOperatorCapability;
  observed_at: string;
  usage_trusted: boolean;
  stale: false;
  effective_at: string;
  current_plan: QuotaApiEntitlementSummary | null;
  target_plan: Readonly<{
    id: string;
    plan_key: string;
    plan_name: string;
    revision: QuotaApiCount;
  }> | null;
  resources: readonly QuotaOpsImpactResource[];
  overage_count: number;
  affected_capabilities: readonly string[];
  before_digest: string | null;
}>;
