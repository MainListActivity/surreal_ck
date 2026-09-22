-- 平台运营机会的内部跟进队列。只保存来源定位与最小处理历史，不复制客户摘要内容。
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
    "activation.followup.read",
    "activation.followup.write",
  ];

DEFINE TABLE IF NOT EXISTS activation_follow_up SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace_slug ON TABLE activation_follow_up TYPE string;
DEFINE FIELD IF NOT EXISTS source_summary ON TABLE activation_follow_up TYPE record<workspace_activation_summary>;
DEFINE FIELD IF NOT EXISTS source_contract_version ON TABLE activation_follow_up TYPE string ASSERT $value INSIDE ["1", "2"];
DEFINE FIELD IF NOT EXISTS source_updated_at ON TABLE activation_follow_up TYPE datetime;
DEFINE FIELD IF NOT EXISTS reason ON TABLE activation_follow_up TYPE string
  ASSERT $value INSIDE ["activation_incomplete", "activation_failed", "review_incomplete", "next_update_missing"];
DEFINE FIELD IF NOT EXISTS period_started_at ON TABLE activation_follow_up TYPE datetime;
DEFINE FIELD IF NOT EXISTS period_ended_at ON TABLE activation_follow_up TYPE datetime;
DEFINE FIELD IF NOT EXISTS period_time_zone ON TABLE activation_follow_up TYPE string;
DEFINE FIELD IF NOT EXISTS dedupe_key ON TABLE activation_follow_up TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE activation_follow_up TYPE string
  ASSERT $value INSIDE ["open", "claimed", "waiting", "resolved", "dismissed"];
DEFINE FIELD IF NOT EXISTS owner_subject ON TABLE activation_follow_up TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE activation_follow_up TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS due_check_at ON TABLE activation_follow_up TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS result ON TABLE activation_follow_up TYPE option<string>;
DEFINE FIELD IF NOT EXISTS version ON TABLE activation_follow_up TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE activation_follow_up TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE activation_follow_up TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS activation_follow_up_dedupe_unique ON TABLE activation_follow_up COLUMNS dedupe_key UNIQUE;
DEFINE INDEX IF NOT EXISTS activation_follow_up_page ON TABLE activation_follow_up COLUMNS updated_at;

DEFINE TABLE IF NOT EXISTS activation_follow_up_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS follow_up ON TABLE activation_follow_up_audit TYPE record<activation_follow_up>;
DEFINE FIELD IF NOT EXISTS action ON TABLE activation_follow_up_audit TYPE string ASSERT $value INSIDE ["created", "claimed", "updated"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE activation_follow_up_audit TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE activation_follow_up_audit TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON TABLE activation_follow_up_audit TYPE string;
DEFINE FIELD IF NOT EXISTS version ON TABLE activation_follow_up_audit TYPE int;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE activation_follow_up_audit TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS activation_follow_up_audit_idempotency_unique
  ON TABLE activation_follow_up_audit COLUMNS actor_subject, idempotency_key UNIQUE;
