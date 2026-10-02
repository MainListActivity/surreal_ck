-- LCA13 修复：023 引入 revoke / repair 两个 claim 动作（service.ts AuditRecord.action
-- 枚举五项），但 product_entitlement_audit.action 的 ASSERT 白名单停在 021 的
-- [publish, assign, grant]，生产执行撤销/交付修复时审计行 insert 被引擎拒绝而 500。
-- 沿用 014–019/024 的 DEFINE FIELD OVERWRITE 惯例把两项新动作并入取值域，
-- 纯放宽校验，不改写已有数据。
DEFINE FIELD OVERWRITE action ON TABLE product_entitlement_audit TYPE string
  ASSERT $value INSIDE ["publish", "assign", "grant", "revoke", "repair"];
