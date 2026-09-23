-- 运营建议审阅与行动结果仅存最小输入摘要；禁止客户正文、token 和模型隐藏推理。
DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read", "subscription.manage", "override.manage", "reconcile.audit", "drift.manage", "ledger.rebuild",
    "content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage",
    "activation.summary.read", "activation.followup.read", "activation.followup.write",
    "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover",
  ];

DEFINE FIELD OVERWRITE action ON TABLE activation_follow_up_audit TYPE string ASSERT $value INSIDE ["created", "claimed", "updated", "taken_over"];
DEFINE FIELD IF NOT EXISTS reason ON TABLE activation_follow_up_audit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS kind ON TABLE platform_operator TYPE string DEFAULT "human" ASSERT $value INSIDE ["human", "agent"];
UPDATE platform_operator SET kind = "human" WHERE kind = NONE;

DEFINE TABLE IF NOT EXISTS ops_proposal SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS follow_up ON TABLE ops_proposal TYPE record<activation_follow_up>;
DEFINE FIELD IF NOT EXISTS source_summary ON TABLE ops_proposal TYPE record<workspace_activation_summary>;
DEFINE FIELD IF NOT EXISTS source_updated_at ON TABLE ops_proposal TYPE datetime;
DEFINE FIELD IF NOT EXISTS follow_up_version ON TABLE ops_proposal TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS action ON TABLE ops_proposal TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS action_digest ON TABLE ops_proposal TYPE string;
DEFINE FIELD IF NOT EXISTS rationale ON TABLE ops_proposal TYPE string;
DEFINE FIELD IF NOT EXISTS expected_result ON TABLE ops_proposal TYPE string;
DEFINE FIELD IF NOT EXISTS trigger_reason ON TABLE ops_proposal TYPE string;
DEFINE FIELD IF NOT EXISTS input_summary ON TABLE ops_proposal TYPE string;
DEFINE FIELD IF NOT EXISTS proposer_subject ON TABLE ops_proposal TYPE string;
DEFINE FIELD IF NOT EXISTS agent_id ON TABLE ops_proposal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON TABLE ops_proposal TYPE string ASSERT $value INSIDE ["pending", "approved", "rejected", "executing", "succeeded", "failed", "stale"];
DEFINE FIELD IF NOT EXISTS version ON TABLE ops_proposal TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS executor_subject ON TABLE ops_proposal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reviewer_subject ON TABLE ops_proposal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS review_reason ON TABLE ops_proposal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tool_result ON TABLE ops_proposal TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS action_follow_up_version ON TABLE ops_proposal TYPE option<int>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ops_proposal TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ops_proposal TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ops_proposal_page ON TABLE ops_proposal COLUMNS updated_at;

DEFINE TABLE IF NOT EXISTS ops_proposal_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS proposal ON TABLE ops_proposal_audit TYPE record<ops_proposal>;
DEFINE FIELD IF NOT EXISTS event ON TABLE ops_proposal_audit TYPE string ASSERT $value INSIDE ["submitted", "approved", "rejected", "execution_started", "succeeded", "failed", "stale"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE ops_proposal_audit TYPE string;
DEFINE FIELD IF NOT EXISTS agent_id ON TABLE ops_proposal_audit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS trigger_reason ON TABLE ops_proposal_audit TYPE string;
DEFINE FIELD IF NOT EXISTS input_summary ON TABLE ops_proposal_audit TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE ops_proposal_audit TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON TABLE ops_proposal_audit TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE ops_proposal_audit TYPE string;
DEFINE FIELD IF NOT EXISTS tool_result ON TABLE ops_proposal_audit TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS version ON TABLE ops_proposal_audit TYPE int;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE ops_proposal_audit TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ops_proposal_audit_idempotency ON TABLE ops_proposal_audit COLUMNS actor_subject, idempotency_key UNIQUE;
