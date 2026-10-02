-- LCA13 修复：code 枚举已含 entitlement.gift / entitlement.repair（023 引入路由能力分权），
-- 但 platform_operator_capability.capability 的 ASSERT 白名单未随之扩展，
-- 生产 seed 写入两项新能力即触发 schema 拒绝并回滚。沿用 014/015/017/018/019 的
-- DEFINE FIELD OVERWRITE 惯例，把两项 entitlement.* 能力并入取值域。纯放宽校验，不改写数据。
DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read", "subscription.manage", "override.manage", "reconcile.audit", "drift.manage", "ledger.rebuild",
    "content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage",
    "entitlement.gift", "entitlement.repair",
    "activation.summary.read", "activation.followup.read", "activation.followup.write",
    "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover",
    "activation.autonomy.read", "activation.autonomy.manage",
  ];
