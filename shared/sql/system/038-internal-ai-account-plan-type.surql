-- 内部AI配额型证据契约 v2：reviewed-token-plan 文档改收供应商账户计划类型读回值
-- account_plan_type（只接受 TOKEN_PLAN_PLAN_TYPE_FREE），替代 v1 无可核定来源的
-- no_payment_instrument/auto_topup_disabled 账户级断言。v1 文档全部过期且判无效、
-- 无在飞消费者，双端同步切换。只新增字段，不回填、不改写或删除既有生产数据；
-- no_payment_instrument 列保留兼容历史行，但不再由 token-plan 文档灌入；
-- auto_topup_disabled 继续由我方计量配置断言（登记初始 true），不取自供应商文档。

DEFINE FIELD IF NOT EXISTS account_plan_type ON internal_ai_activity TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["TOKEN_PLAN_PLAN_TYPE_FREE"];

-- revision 侧同名字段：账户计划类型读回进审计历史，READONLY 只增。
DEFINE FIELD IF NOT EXISTS account_plan_type ON internal_ai_revision TYPE option<string>
  READONLY
  ASSERT $value = NONE OR $value INSIDE ["TOKEN_PLAN_PLAN_TYPE_FREE"];
