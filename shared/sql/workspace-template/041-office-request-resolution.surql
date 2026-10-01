-- VO03：人类请求一次性解决闭环。
--
-- user_notification 在 031/032 已通用化（purpose/payload/task/answer）并带终态守卫。
-- 本增量把"请求"语义收口到只有收件人能写终态、员工能读回自己请求的出口：
--
-- 1. 身份与内容字段创建后只读：dedupe_key/title/body/severity/requested_action/
--    matched_fields/rule/checked_at/workbook/related_record/risk_type/task/purpose
--    全部补 READONLY——收件人的 UPDATE 从此只能落在 resolution/resolved_at/answer
--    三个终态字段上，sender/recipient/问题 payload/创建时间的不可改写闭合完整。
--    债权提醒的 ON DUPLICATE KEY UPDATE 只把 dedupe_key 写回原值（同值不触发
--    READONLY 拒绝），存量行与写入路径零影响。
-- 2. 员工可读回自己发出的请求：FOR select 放行 from_employee——唤醒后的后续执行
--    在员工自身会话里读答复与终态，root 不进入这条业务路径。
-- 3. answer 结构化：一旦写入必须是带合法 action 的对象（answered/rejected/
--    cancelled），"答复/拒绝/取消"三类终态同构；改写仍由 032 的终态守卫 THROW。

DEFINE TABLE OVERWRITE user_notification SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE
      to_user = fn::current_user()
      OR from_employee = fn::current_user()
      OR fn::current_user().is_admin = true,
    FOR create WHERE $auth.kind = "virtual" AND from_employee = fn::current_user(),
    FOR update WHERE to_user = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete WHERE fn::current_user().is_admin = true;

DEFINE FIELD OVERWRITE dedupe_key ON TABLE user_notification TYPE string READONLY;
DEFINE FIELD OVERWRITE title ON TABLE user_notification TYPE string READONLY;
DEFINE FIELD OVERWRITE body ON TABLE user_notification TYPE string READONLY;
DEFINE FIELD OVERWRITE severity ON TABLE user_notification TYPE string READONLY
  ASSERT $value INSIDE ["info", "warning", "urgent"];
DEFINE FIELD OVERWRITE requested_action ON TABLE user_notification TYPE option<string> READONLY;
DEFINE FIELD OVERWRITE matched_fields ON TABLE user_notification TYPE option<object> FLEXIBLE READONLY;
DEFINE FIELD OVERWRITE rule ON TABLE user_notification TYPE option<string> READONLY;
DEFINE FIELD OVERWRITE checked_at ON TABLE user_notification TYPE option<datetime> READONLY;
DEFINE FIELD OVERWRITE workbook ON TABLE user_notification TYPE option<record<workbook>> READONLY;
DEFINE FIELD OVERWRITE related_record ON TABLE user_notification TYPE option<record> READONLY;
DEFINE FIELD OVERWRITE risk_type ON TABLE user_notification TYPE option<string> READONLY
  ASSERT $value = NONE OR $value INSIDE ["missing-material", "due-within-seven-days", "amount-anomaly"];
DEFINE FIELD OVERWRITE task ON TABLE user_notification TYPE option<record<office_task>> READONLY;
DEFINE FIELD OVERWRITE purpose ON TABLE user_notification TYPE option<string> DEFAULT "claims-risk" READONLY
  ASSERT $value = NONE OR $value INSIDE ["claims-risk", "office-request", "info"];

-- answer 结构化：带 action 键的对象（办公室三态终态）必须落合法枚举；
-- 无 action 的自由形态答案（如 {choice:"A"}，VO01 既有合约）不受影响。
DEFINE FIELD OVERWRITE answer ON TABLE user_notification TYPE option<object> FLEXIBLE
  ASSERT $value = NONE OR $value.action = NONE
    OR $value.action INSIDE ["answered", "rejected", "cancelled"];
