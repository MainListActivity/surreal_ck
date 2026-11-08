-- 远程测试主体（remote test subjects）：VPS 一次性兑换授权的产品侧登记。
-- test_subject 标记「会被自动清理的测试账号 subject」；workspace 上同名字段
-- 标记该库属于测试主体，到期由 test-subject reaper 连库带索引删除。
-- 仅 root/后端可读写；能力白名单追加 test.manage（照 045 的增量方式，幂等可重复执行）。

DEFINE TABLE IF NOT EXISTS test_subject SCHEMAFULL
  PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS subject ON TABLE test_subject TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE test_subject TYPE option<string>;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE test_subject TYPE datetime;
DEFINE FIELD IF NOT EXISTS origin ON TABLE test_subject TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE test_subject TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE test_subject TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS test_subject_subject_unique ON TABLE test_subject COLUMNS subject UNIQUE;
DEFINE INDEX IF NOT EXISTS test_subject_expires_at ON TABLE test_subject COLUMNS expires_at;

DEFINE FIELD IF NOT EXISTS test_expires_at ON TABLE workspace TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS test_origin ON TABLE workspace TYPE option<string>;
DEFINE INDEX IF NOT EXISTS workspace_test_expires_at ON TABLE workspace COLUMNS test_expires_at;

DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read", "subscription.manage", "override.manage", "reconcile.audit", "drift.manage", "ledger.rebuild",
    "content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage",
    "entitlement.gift", "entitlement.repair",
    "activation.summary.read", "activation.followup.read", "activation.followup.write",
    "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover",
    "activation.autonomy.read", "activation.autonomy.manage",
    "rollout.manage",
    "funnel.read",
    "internal-ai.endpoint-probe",
    "test.manage",
  ];
