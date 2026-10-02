-- LCA14 受控灰度：workspace 级「新法律内容访问 / 法律研究 AI」独立开关、具名批次与操作审计。
-- 只新增结构 + 放宽 platform_operator_capability 能力白名单（新增 rollout.manage），不改写既有数据。

DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read", "subscription.manage", "override.manage", "reconcile.audit", "drift.manage", "ledger.rebuild",
    "content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage",
    "entitlement.gift", "entitlement.repair",
    "activation.summary.read", "activation.followup.read", "activation.followup.write",
    "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover",
    "activation.autonomy.read", "activation.autonomy.manage",
    "rollout.manage",
  ];

-- 具名灰度批次：一次受控发布的完整事实登记（应用/IdP 发布、schema/权益修订、
-- 合法来源、商品费率与试用额度、历史订阅映射、受控名单、缺项未开放范围）。
DEFINE TABLE IF NOT EXISTS rollout_batch SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS batch_key ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS label ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS status ON rollout_batch TYPE string
  ASSERT $value INSIDE ["draft", "active", "closed"];
DEFINE FIELD IF NOT EXISTS app_release ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS idp_release ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS schema_revision ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS legal_sources ON rollout_batch TYPE array<object>;
DEFINE FIELD IF NOT EXISTS legal_sources.*.source_key ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS legal_sources.*.label ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS legal_sources.*.license_note ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS plan_mapping ON rollout_batch TYPE array<object>;
DEFINE FIELD IF NOT EXISTS plan_mapping.*.plan_key ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS plan_mapping.*.display_name ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS plan_mapping.*.ai_rate ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS plan_mapping.*.trial_allowance ON rollout_batch TYPE option<int>
  ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD IF NOT EXISTS plan_mapping.*.legacy_subscription_map ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS allowed_workspaces ON rollout_batch TYPE array<string>;
DEFINE FIELD IF NOT EXISTS allowed_workspaces.* ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS gaps ON rollout_batch TYPE array<string>;
DEFINE FIELD IF NOT EXISTS gaps.* ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS created_by_subject ON rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON rollout_batch TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS activated_by_subject ON rollout_batch TYPE option<string>;
DEFINE FIELD IF NOT EXISTS activated_at ON rollout_batch TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS closed_by_subject ON rollout_batch TYPE option<string>;
DEFINE FIELD IF NOT EXISTS closed_at ON rollout_batch TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS close_reason ON rollout_batch TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at ON rollout_batch TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS rollout_batch_key_unique ON rollout_batch COLUMNS batch_key UNIQUE;

-- workspace 级灰度开关当前状态。无行 = enabled（默认不收紧）；行存在即记录当前态与操作序位。
DEFINE TABLE IF NOT EXISTS workspace_rollout_gate SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON workspace_rollout_gate TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS gate ON workspace_rollout_gate TYPE string
  ASSERT $value INSIDE ["legal_content_access", "legal_research_ai"];
DEFINE FIELD IF NOT EXISTS state ON workspace_rollout_gate TYPE string
  ASSERT $value INSIDE ["enabled", "disabled"];
DEFINE FIELD IF NOT EXISTS revision ON workspace_rollout_gate TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS reason ON workspace_rollout_gate TYPE string;
DEFINE FIELD IF NOT EXISTS batch_key ON workspace_rollout_gate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_by_subject ON workspace_rollout_gate TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON workspace_rollout_gate TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON workspace_rollout_gate TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_rollout_gate_unique ON workspace_rollout_gate COLUMNS workspace, gate UNIQUE;

-- 操作事件（审计唯一事实源）：gate 开关切换与批次注册/流转各占一种 kind。
-- 事件先占位（actor+idempotency_key 唯一）再应用状态；before/after 记录恢复点。
DEFINE TABLE IF NOT EXISTS rollout_operation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS kind ON rollout_operation TYPE string
  ASSERT $value INSIDE ["gate_disable", "gate_restore", "batch_register", "batch_activate", "batch_close"];
DEFINE FIELD IF NOT EXISTS gate ON rollout_operation TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["legal_content_access", "legal_research_ai"];
DEFINE FIELD IF NOT EXISTS workspace ON rollout_operation TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS workspace_slug ON rollout_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS batch_key ON rollout_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actor_subject ON rollout_operation TYPE string;
DEFINE FIELD IF NOT EXISTS authorized_capability ON rollout_operation TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON rollout_operation TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON rollout_operation TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON rollout_operation TYPE string;
DEFINE FIELD IF NOT EXISTS before_state ON rollout_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS after_state ON rollout_operation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS before_revision ON rollout_operation TYPE option<int>;
DEFINE FIELD IF NOT EXISTS after_revision ON rollout_operation TYPE option<int>;
DEFINE FIELD IF NOT EXISTS correlation_id ON rollout_operation TYPE string;
DEFINE FIELD IF NOT EXISTS occurred_at ON rollout_operation TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS rollout_operation_idempotency ON rollout_operation COLUMNS actor_subject, idempotency_key UNIQUE;
DEFINE INDEX IF NOT EXISTS rollout_operation_workspace ON rollout_operation COLUMNS workspace, occurred_at;
DEFINE INDEX IF NOT EXISTS rollout_operation_batch ON rollout_operation COLUMNS batch_key;
DEFINE EVENT IF NOT EXISTS rollout_operation_immutable ON rollout_operation
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:rollout_operation";
  };
