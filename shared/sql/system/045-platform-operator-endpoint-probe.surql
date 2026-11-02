-- 受控目录认证探针（2792e7f7）：放开 platform_operator_capability 能力白名单，
-- 只追加 internal-ai.endpoint-probe。与 041 同位置的白名单此前止于 funnel.read，
-- 而 TypeScript 联合 PLATFORM_OPERATOR_CAPABILITIES 已追加 internal-ai.endpoint-probe；
-- 白名单未同步会让 seed 授权该能力被 _system schema 拒绝。
--
-- 增量语义：只新增允许值，不改写既有记录、不删除任何能力、不改变字段类型与
-- 其它约束。DEFINE FIELD OVERWRITE 幂等，重复执行安全；既有 capability 行不受影响。
-- 注：本迁移只放宽 schema，不授予任何主体能力——授予仍由生产
-- ORIGIN_ENV_PLATFORM_OPERATOR_CAPABILITIES 的 CSV 决定；在该 CSV 显式加入之前，
-- 没有任何运营主体持有该能力，探针默认拒绝。

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
  ];
