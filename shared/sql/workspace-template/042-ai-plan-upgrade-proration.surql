-- LCA08 AC5/AC6：试用来源终止标记 + 周期内升级按剩余周期独立补发的折算状态。
-- 只新增结构（字段/表），不回写、不删除任何既有数据；旧记录上新字段读作
-- NONE，读端据此 fail-closed，不做历史数据迁移。

-- ── 桶终止标记：试用提前转付费的商业确认生效时，由 plan-cycle 同步器写入 ──
-- 关联旧试用桶（period_key 前缀 trial:<订阅ID>:）被标记终止：立即失去新
-- reserve 与可消费 balance 资格；金额字段（total/available/reserved/settled）
-- 绝不改动，不删除、不改写旧账本；其上既有预留仍可在执行窗口内按原桶结算，
-- 释放/清扫只记 writeoff 冲销，不返还可消费余额。标记幂等且永不撤销。
DEFINE FIELD IF NOT EXISTS terminated_at ON TABLE ai_allowance_bucket TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS terminated_note ON TABLE ai_allowance_bucket TYPE option<string>;
-- 升级补发桶审计：产生补发的已确认商业事件（订阅项）与目标额度。
DEFINE FIELD IF NOT EXISTS upgrade_event_key ON TABLE ai_allowance_bucket TYPE option<string>;
DEFINE FIELD IF NOT EXISTS upgrade_target ON TABLE ai_allowance_bucket TYPE option<int>;

-- ── 周期升级折算累计状态：每周期一行（period_key 唯一）─────────────────────
-- 保存已兑现最高完整周期额度 H、未取整累计补发分子 r_num（分母 r_den 为周期
-- 时长毫秒，全部精确整数运算）与历史已授予补发额度 granted_total；events 记录
-- 已处理的已确认商业事件键（同一事件/目标修订/周期唯一去重）。H 仅增长，不因
-- 降级、消费或重放降低。规则版本 lca08-upgrade-proration-test-v1 只用于测试
-- 报价与验收；生产数值必须来自获批的商品修订，不得推定测试值为生产套餐。
DEFINE TABLE IF NOT EXISTS ai_plan_upgrade_state SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS period_key ON TABLE ai_plan_upgrade_state TYPE string;
DEFINE FIELD IF NOT EXISTS rule_version ON TABLE ai_plan_upgrade_state TYPE string;
DEFINE FIELD IF NOT EXISTS high_water ON TABLE ai_plan_upgrade_state TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS r_num ON TABLE ai_plan_upgrade_state TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS r_den ON TABLE ai_plan_upgrade_state TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS granted_total ON TABLE ai_plan_upgrade_state TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS events ON TABLE ai_plan_upgrade_state TYPE array;
DEFINE FIELD IF NOT EXISTS events.* ON TABLE ai_plan_upgrade_state TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ai_plan_upgrade_state TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ai_plan_upgrade_state TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ai_plan_upgrade_state_period_unique
  ON TABLE ai_plan_upgrade_state COLUMNS period_key UNIQUE;
