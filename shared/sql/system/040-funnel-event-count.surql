-- funnel_event_count：漏斗埋点的 _system 日计数（方案 A 汇总目标，任务 d70c3748 第 4 版）。
--
-- 只新增结构，不改写已有数据。行由服务端聚合任务按日从各工作区库的 funnel_event、
-- activity_event 与 _system.ops_invitation 重算后 UPSERT：count 恒等于重算值，
-- 重复执行幂等。工作区标识 workspace_key 是 HMAC(FUNNEL_HASH_KEY, db_name)
-- 的十六进制摘要，不可逆；无密钥时聚合任务不写入。
--
-- 允许字段仅以下四个（方案 §2）：event、day、workspace_key、count。
-- 禁止存记录内容、文件名、债权人名、金额、邮箱、IP、用户标识明文。
-- return_week2 / invite_issued 的口径见方案 §1、§5、§6。

DEFINE TABLE IF NOT EXISTS funnel_event_count SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS event ON TABLE funnel_event_count TYPE string
  ASSERT $value INSIDE [
    "invite_issued", "first_login", "template_created",
    "import_succeeded", "first_success", "ai_proposal_adopted", "return_week2"
  ];
DEFINE FIELD IF NOT EXISTS day ON TABLE funnel_event_count TYPE string
  ASSERT $value != NONE AND string::len($value) = 10;
DEFINE FIELD IF NOT EXISTS workspace_key ON TABLE funnel_event_count TYPE string
  ASSERT $value != NONE;
DEFINE FIELD IF NOT EXISTS count ON TABLE funnel_event_count TYPE int
  ASSERT $value >= 0;
DEFINE INDEX IF NOT EXISTS funnel_event_count_key ON TABLE funnel_event_count COLUMNS event, day, workspace_key UNIQUE;
