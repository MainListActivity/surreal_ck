-- 外部运营 agent 的工作区/动作授权与暂停历史；不保存 token 或客户业务内容。
DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read", "subscription.manage", "override.manage", "reconcile.audit", "drift.manage", "ledger.rebuild",
    "content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage",
    "activation.summary.read", "activation.followup.read", "activation.followup.write",
    "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover",
    "activation.autonomy.read", "activation.autonomy.manage",
  ];

DEFINE TABLE IF NOT EXISTS ops_agent_policy SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS agent_subject ON TABLE ops_agent_policy TYPE string;
DEFINE FIELD IF NOT EXISTS workspace_slug ON TABLE ops_agent_policy TYPE string;
DEFINE FIELD IF NOT EXISTS actions ON TABLE ops_agent_policy TYPE array<string>;
DEFINE FIELD IF NOT EXISTS status ON TABLE ops_agent_policy TYPE string ASSERT $value INSIDE ["active", "paused", "revoked"];
DEFINE FIELD IF NOT EXISTS version ON TABLE ops_agent_policy TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS updated_by_subject ON TABLE ops_agent_policy TYPE string;
DEFINE FIELD IF NOT EXISTS last_request_digest ON TABLE ops_agent_policy TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ops_agent_policy TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ops_agent_policy_identity ON TABLE ops_agent_policy COLUMNS agent_subject, workspace_slug UNIQUE;

DEFINE TABLE IF NOT EXISTS ops_agent_policy_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS policy ON TABLE ops_agent_policy_audit TYPE record<ops_agent_policy>;
DEFINE FIELD IF NOT EXISTS event ON TABLE ops_agent_policy_audit TYPE string ASSERT $value INSIDE ["configured", "paused", "resumed", "revoked"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE ops_agent_policy_audit TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON TABLE ops_agent_policy_audit TYPE string;
DEFINE FIELD IF NOT EXISTS version ON TABLE ops_agent_policy_audit TYPE int;
DEFINE FIELD IF NOT EXISTS request_digest ON TABLE ops_agent_policy_audit TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key_hash ON TABLE ops_agent_policy_audit TYPE string;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE ops_agent_policy_audit TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ops_agent_policy_audit_idempotency ON TABLE ops_agent_policy_audit COLUMNS actor_subject, idempotency_key_hash UNIQUE;
