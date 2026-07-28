import type {
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
  statuses: QuotaApiStatuses;
  utilization: Readonly<{
    capacity: QuotaCapacityState;
    highest_percent: number | null;
    usage_trusted: boolean;
    stale: boolean;
  }>;
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
      workspace_record: string;
      database: string;
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
