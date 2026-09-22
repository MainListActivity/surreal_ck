-- 工作区管理员主动提交的最小启用摘要投影。内容是团队提供的数据，不能用于计费或授权。
DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read",
    "subscription.manage",
    "override.manage",
    "reconcile.audit",
    "drift.manage",
    "ledger.rebuild",
    "content.read",
    "content.submit",
    "content.publish",
    "content.withdraw",
    "content.restore",
    "content.source.manage",
    "activation.summary.read",
  ];

DEFINE TABLE IF NOT EXISTS workspace_activation_summary SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_activation_summary TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS workspace_slug ON TABLE workspace_activation_summary TYPE string;
DEFINE FIELD IF NOT EXISTS contract_version ON TABLE workspace_activation_summary TYPE string
  ASSERT $value INSIDE ["1"];
DEFINE FIELD IF NOT EXISTS dedupe_key ON TABLE workspace_activation_summary TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE workspace_activation_summary TYPE string
  ASSERT $value INSIDE ["active", "withdrawn"];
DEFINE FIELD IF NOT EXISTS content ON TABLE workspace_activation_summary TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS supplied_by_subject ON TABLE workspace_activation_summary TYPE option<string>;
DEFINE FIELD IF NOT EXISTS supplied_at ON TABLE workspace_activation_summary TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workspace_activation_summary TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_activation_summary_workspace_unique
  ON TABLE workspace_activation_summary COLUMNS workspace UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_activation_summary_page
  ON TABLE workspace_activation_summary COLUMNS updated_at, workspace_slug;

-- 仅保留动作、操作者和幂等身份；撤回后不在审计中复制摘要内容。
DEFINE TABLE IF NOT EXISTS workspace_activation_summary_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS summary ON TABLE workspace_activation_summary_audit TYPE record<workspace_activation_summary>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_activation_summary_audit TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS action ON TABLE workspace_activation_summary_audit TYPE string
  ASSERT $value INSIDE ["shared", "withdrawn"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE workspace_activation_summary_audit TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE workspace_activation_summary_audit TYPE string;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE workspace_activation_summary_audit TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_activation_summary_audit_idempotency_unique
  ON TABLE workspace_activation_summary_audit COLUMNS workspace, idempotency_key UNIQUE;
