-- Native quota commercial authority.
-- `_system` is root-only; every table still declares PERMISSIONS NONE so a
-- database-scoped session can never turn billing membership into data access.

DEFINE TABLE IF NOT EXISTS billing_account SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS account_key ON TABLE billing_account TYPE string;
DEFINE FIELD IF NOT EXISTS name ON TABLE billing_account TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON TABLE billing_account TYPE string
  ASSERT $value INSIDE ["personal", "team", "enterprise"];
DEFINE FIELD IF NOT EXISTS status ON TABLE billing_account TYPE string
  ASSERT $value INSIDE ["active", "closed"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE billing_account TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE billing_account TYPE datetime
  VALUE time::now();
DEFINE FIELD IF NOT EXISTS closed_at ON TABLE billing_account TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS billing_account_key_unique ON TABLE billing_account COLUMNS account_key
  UNIQUE;

DEFINE TABLE IF NOT EXISTS billing_account_member SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS billing_account ON TABLE billing_account_member TYPE record<billing_account>;
DEFINE FIELD IF NOT EXISTS subject ON TABLE billing_account_member TYPE string;
DEFINE FIELD IF NOT EXISTS role ON TABLE billing_account_member TYPE string
  ASSERT $value INSIDE ["owner", "admin", "viewer"];
DEFINE FIELD IF NOT EXISTS status ON TABLE billing_account_member TYPE string
  ASSERT $value INSIDE ["active", "revoked"];
DEFINE FIELD IF NOT EXISTS joined_at ON TABLE billing_account_member TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS revoked_at ON TABLE billing_account_member TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE billing_account_member TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS billing_account_member_unique ON TABLE billing_account_member COLUMNS billing_account, subject
  UNIQUE;
DEFINE INDEX IF NOT EXISTS billing_account_member_subject ON TABLE billing_account_member COLUMNS subject;

DEFINE TABLE IF NOT EXISTS quota_plan SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS plan_key ON TABLE quota_plan TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE quota_plan TYPE string;
DEFINE FIELD IF NOT EXISTS visibility ON TABLE quota_plan TYPE string
  ASSERT $value INSIDE ["public", "internal"];
DEFINE FIELD IF NOT EXISTS status ON TABLE quota_plan TYPE string
  ASSERT $value INSIDE ["active", "retired"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_plan TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_plan TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS quota_plan_key_unique ON TABLE quota_plan COLUMNS plan_key
  UNIQUE;

DEFINE TABLE IF NOT EXISTS quota_plan_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS plan ON TABLE quota_plan_revision TYPE record<quota_plan>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE quota_plan_revision TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS template_kind ON TABLE quota_plan_revision TYPE string
  ASSERT $value INSIDE ["commercial", "trial", "contract", "retention"];
DEFINE FIELD IF NOT EXISTS rules ON TABLE quota_plan_revision TYPE array<object>;
DEFINE FIELD IF NOT EXISTS rules.*.rule_key ON TABLE quota_plan_revision TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.resource ON TABLE quota_plan_revision TYPE string
  ASSERT $value INSIDE ["table", "field", "record"];
DEFINE FIELD IF NOT EXISTS rules.*.selector ON TABLE quota_plan_revision TYPE object;
DEFINE FIELD IF NOT EXISTS rules.*.selector.kind ON TABLE quota_plan_revision TYPE string
  ASSERT $value INSIDE ["exact", "regex"];
DEFINE FIELD IF NOT EXISTS rules.*.selector.value ON TABLE quota_plan_revision TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.limit ON TABLE quota_plan_revision TYPE object;
DEFINE FIELD IF NOT EXISTS rules.*.limit.kind ON TABLE quota_plan_revision TYPE string
  ASSERT $value INSIDE ["finite", "unlimited"];
DEFINE FIELD IF NOT EXISTS rules.*.limit.value ON TABLE quota_plan_revision TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS rules.*.customer_label ON TABLE quota_plan_revision TYPE string;
DEFINE FIELD IF NOT EXISTS rules.*.customer_description ON TABLE quota_plan_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE quota_plan_revision TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_plan_revision TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS published_at ON TABLE quota_plan_revision TYPE datetime;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_plan_revision TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_plan_revision TYPE option<string>;
DEFINE INDEX IF NOT EXISTS quota_plan_revision_unique ON TABLE quota_plan_revision COLUMNS plan, revision
  UNIQUE;
DEFINE EVENT IF NOT EXISTS quota_plan_revision_immutable ON TABLE quota_plan_revision
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_plan_revision";
  };

DEFINE FIELD IF NOT EXISTS active_revision ON TABLE quota_plan TYPE option<record<quota_plan_revision>>;

DEFINE TABLE IF NOT EXISTS quota_subscription SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS billing_account ON TABLE quota_subscription TYPE record<billing_account>;
DEFINE FIELD IF NOT EXISTS source ON TABLE quota_subscription TYPE string
  ASSERT $value INSIDE ["provider", "manual", "contract"];
DEFINE FIELD IF NOT EXISTS status ON TABLE quota_subscription TYPE string
  ASSERT $value INSIDE [
    "pending",
    "trialing",
    "active",
    "past_due",
    "paused",
    "canceled",
    "expired",
  ];
DEFINE FIELD IF NOT EXISTS revision ON TABLE quota_subscription TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS provider ON TABLE quota_subscription TYPE option<string>;
DEFINE FIELD IF NOT EXISTS provider_customer_id ON TABLE quota_subscription TYPE option<string>;
DEFINE FIELD IF NOT EXISTS provider_subscription_id ON TABLE quota_subscription TYPE option<string>;
DEFINE FIELD IF NOT EXISTS provider_source_revision ON TABLE quota_subscription TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS current_period_start ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS current_period_end ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS trial_start ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS trial_end ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS paid_through ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS grace_until ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cancel_at_period_end ON TABLE quota_subscription TYPE bool
  DEFAULT false;
DEFINE FIELD IF NOT EXISTS cancel_at ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS canceled_at ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE quota_subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_subscription TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_subscription TYPE datetime
  VALUE time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_subscription TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_subscription TYPE option<string>;
DEFINE INDEX IF NOT EXISTS quota_subscription_provider_unique ON TABLE quota_subscription COLUMNS provider, provider_subscription_id
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_subscription_billing_account ON TABLE quota_subscription COLUMNS billing_account;

DEFINE TABLE IF NOT EXISTS quota_subscription_item SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS subscription ON TABLE quota_subscription_item TYPE record<quota_subscription>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_subscription_item TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS plan_revision ON TABLE quota_subscription_item TYPE record<quota_plan_revision>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE quota_subscription_item TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS status ON TABLE quota_subscription_item TYPE string
  ASSERT $value INSIDE ["scheduled", "active", "ended"];
DEFINE FIELD IF NOT EXISTS effective_from ON TABLE quota_subscription_item TYPE datetime;
DEFINE FIELD IF NOT EXISTS effective_until ON TABLE quota_subscription_item TYPE option<datetime>
  ASSERT $value = NONE
  OR $value > effective_from;
DEFINE FIELD IF NOT EXISTS active_workspace ON TABLE quota_subscription_item TYPE option<record<workspace>>
  VALUE IF status = "active" THEN workspace ELSE NONE END;
DEFINE FIELD IF NOT EXISTS ended_reason ON TABLE quota_subscription_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_subscription_item TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_subscription_item TYPE datetime
  VALUE time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_subscription_item TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_subscription_item TYPE option<string>;
DEFINE INDEX IF NOT EXISTS quota_subscription_item_active_workspace_unique ON TABLE quota_subscription_item COLUMNS active_workspace
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_subscription_item_subscription ON TABLE quota_subscription_item COLUMNS subscription;
DEFINE INDEX IF NOT EXISTS quota_subscription_item_workspace ON TABLE quota_subscription_item COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS quota_override_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE quota_override_revision TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE quota_override_revision TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS previous_revision ON TABLE quota_override_revision TYPE option<record<quota_override_revision>>;
DEFINE FIELD IF NOT EXISTS patches ON TABLE quota_override_revision TYPE array<object>;
DEFINE FIELD IF NOT EXISTS patches.*.rule_key ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS patches.*.action ON TABLE quota_override_revision TYPE string
  ASSERT $value INSIDE ["replace", "disable"];
DEFINE FIELD IF NOT EXISTS patches.*.selector ON TABLE quota_override_revision TYPE option<object>;
DEFINE FIELD IF NOT EXISTS patches.*.selector.kind ON TABLE quota_override_revision TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE ["exact", "regex"];
DEFINE FIELD IF NOT EXISTS patches.*.selector.value ON TABLE quota_override_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS patches.*.limit ON TABLE quota_override_revision TYPE option<object>;
DEFINE FIELD IF NOT EXISTS patches.*.limit.kind ON TABLE quota_override_revision TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE ["finite", "unlimited"];
DEFINE FIELD IF NOT EXISTS patches.*.limit.value ON TABLE quota_override_revision TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS customer_reason ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS operator_reason ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS authorized_capability ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS effective_at ON TABLE quota_override_revision TYPE datetime;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE quota_override_revision TYPE option<datetime>
  ASSERT $value = NONE
  OR $value > effective_at;
DEFINE FIELD IF NOT EXISTS request_id ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE quota_override_revision TYPE string;
DEFINE FIELD IF NOT EXISTS causation_id ON TABLE quota_override_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE quota_override_revision TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS quota_override_revision_unique ON TABLE quota_override_revision COLUMNS workspace, revision
  UNIQUE;
DEFINE INDEX IF NOT EXISTS quota_override_revision_request_unique ON TABLE quota_override_revision COLUMNS request_id
  UNIQUE;
DEFINE EVENT IF NOT EXISTS quota_override_revision_immutable ON TABLE quota_override_revision
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-control-plane-record:quota_override_revision";
  };

-- One mutable assignment row per workspace gives the resolver at most one
-- active and one scheduled override without mutating immutable revisions.
DEFINE TABLE IF NOT EXISTS workspace_quota_override SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_quota_override TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS active_revision ON TABLE workspace_quota_override TYPE option<record<quota_override_revision>>;
DEFINE FIELD IF NOT EXISTS scheduled_revision ON TABLE workspace_quota_override TYPE option<record<quota_override_revision>>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workspace_quota_override TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_quota_override_workspace_unique ON TABLE workspace_quota_override COLUMNS workspace
  UNIQUE;
