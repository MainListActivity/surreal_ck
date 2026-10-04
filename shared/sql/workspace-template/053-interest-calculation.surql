-- 11.1 债权对账 · 利息重算快照 interest_calculation（只新增结构）。
-- 契约见 docs/claims-reconciliation/data-model.md §5 与 interest-rules.md：
-- 每次重算追加新行、不覆盖旧行。参与者可 select/create 追加快照，
-- 记录会话不能改行或删行，全部业务字段 READONLY——
-- 规则文档或代码以后升级，历史行的 rule_version 与 segments 仍保持当时的值。
-- admin 会话（RL=Owner）绕过 PERMISSIONS，可直连读写；债权人与匿名无任何权限。

DEFINE TABLE IF NOT EXISTS interest_calculation SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR update, delete
      WHERE false;

DEFINE FIELD IF NOT EXISTS submission_id ON TABLE interest_calculation
  TYPE record<claim_submission> READONLY;
DEFINE FIELD IF NOT EXISTS rule_version ON TABLE interest_calculation
  TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 64;
-- 输入快照：本金、分段原始输入、起止日、计息方式、违约金约定。
DEFINE FIELD IF NOT EXISTS inputs ON TABLE interest_calculation
  TYPE object FLEXIBLE READONLY;
-- 每段 {index,start,end,days,base,annual_rate,interest}；array<object> 需显式
-- FLEXIBLE 子定义（049/052 同模式），否则 SCHEMAFULL 生成非 FLEXIBLE 隐式子定义。
DEFINE FIELD IF NOT EXISTS segments ON TABLE interest_calculation
  TYPE array<object> FLEXIBLE READONLY;
DEFINE FIELD IF NOT EXISTS segments.* ON TABLE interest_calculation
  TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS days_total ON TABLE interest_calculation
  TYPE int READONLY
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS total_interest ON TABLE interest_calculation
  TYPE number READONLY
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS penalty_amount ON TABLE interest_calculation
  TYPE number READONLY
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS total_amount ON TABLE interest_calculation
  TYPE number READONLY
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS calculated_at ON TABLE interest_calculation
  TYPE datetime READONLY;

DEFINE INDEX IF NOT EXISTS interest_calculation_submission
  ON TABLE interest_calculation COLUMNS submission_id, calculated_at;
