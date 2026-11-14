-- 测试物料自助：能力白名单追加 test.provision（运营 MCP test_kit_* 工具）。
-- 只放宽 schema、不授予能力；授予只经 PLATFORM_OPERATOR_TEST_AGENTS seed 给 kind=agent 主体。

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
    "test.provision",
  ];
