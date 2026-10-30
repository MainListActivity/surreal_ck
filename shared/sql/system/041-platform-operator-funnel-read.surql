-- 漏斗埋点（f2ad4be5）生产验收前置：放开 platform_operator_capability 能力白名单，
-- 只追加 funnel.read。与 028 相同位置的能力白名单此前止于 rollout.manage，
-- 而 TypeScript 联合 PLATFORM_OPERATOR_CAPABILITIES 已在 #216 追加 funnel.read；
-- 白名单未同步导致 seed 授权 funnel.read 被 _system schema 拒绝、origin 启动失败
-- 并自动回滚（2026-10-30 run 41069265054）。
--
-- 增量语义：只新增允许值，不改写既有记录、不删除任何能力、不改变字段类型与
-- 其它约束。DEFINE FIELD OVERWRITE 幂等，重复执行安全；既有 capability 行不受影响。
-- 注：本迁移只放宽 schema，不授予任何主体能力——授予仍由生产
-- ORIGIN_ENV_PLATFORM_OPERATOR_CAPABILITIES 的 CSV 决定（当前保持 11 项）。

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
  ];
