-- LCA-14 返工：新内容 / AI 能力的灰度开关（_system 控制面）。
-- 每条开关是一个确定性 record id：platform_capability_switch:content / :ai。
-- mode = on（默认，全量开放）/ cohort（仅 workspaces 内 slug 灰度放行）/ off
-- （立即关闭）。行不存在按 on 处理——未初始化的部署不改变既有行为。
-- 读端在会话签发入口（content-search / content-reader / ai-chat）逐请求求值，
-- 关闭对已下发会话不追溯撤销（既有成果保留）；写入仅经 ops API（root 会话）。
DEFINE TABLE IF NOT EXISTS platform_capability_switch SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS mode ON TABLE platform_capability_switch TYPE string
  ASSERT $value INSIDE ["on", "cohort", "off"];
DEFINE FIELD IF NOT EXISTS workspaces ON TABLE platform_capability_switch TYPE array<string>;
DEFINE FIELD IF NOT EXISTS note ON TABLE platform_capability_switch TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS updated_by ON TABLE platform_capability_switch TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE platform_capability_switch TYPE datetime VALUE time::now();

-- 灰度批次记录：每波受控放行的工作区 cohort 留档（slug 列表 + 说明 + 操作者），
-- 追加式；回滚不删除批次行，新批次行记录收窄结果。
DEFINE TABLE IF NOT EXISTS platform_rollout_batch SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS capability ON TABLE platform_rollout_batch TYPE string
  ASSERT $value INSIDE ["content", "ai"];
DEFINE FIELD IF NOT EXISTS workspaces ON TABLE platform_rollout_batch TYPE array<string>;
DEFINE FIELD IF NOT EXISTS note ON TABLE platform_rollout_batch TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS created_by ON TABLE platform_rollout_batch TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE platform_rollout_batch TYPE datetime VALUE time::now() READONLY;

-- 开关管理走独立能力 capability.switch（与订阅/内容能力分权）；
-- 沿用 024 的 OVERWRITE 惯例放宽 capability 白名单。纯放宽校验，不改写数据。
DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read", "subscription.manage", "override.manage", "reconcile.audit", "drift.manage", "ledger.rebuild",
    "content.read", "content.submit", "content.publish", "content.withdraw", "content.restore", "content.source.manage",
    "entitlement.gift", "entitlement.repair",
    "activation.summary.read", "activation.followup.read", "activation.followup.write",
    "activation.proposal.read", "activation.proposal.submit", "activation.proposal.review", "activation.proposal.execute", "activation.proposal.takeover",
    "activation.autonomy.read", "activation.autonomy.manage",
    "capability.switch",
  ];
