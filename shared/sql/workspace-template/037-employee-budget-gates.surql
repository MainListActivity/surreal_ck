-- VER05：员工每日 token 用量账本与预算闸门信号去重。
--
-- employee_token_usage 按 (employee, day) 唯一，day 是业务时区日期键
-- （runtime 用可配置时区算出 YYYY-MM-DD，默认 Asia/Shanghai）。每天一行：
-- provider_* 列记 provider usage 精确计量，estimated_* 列记无 usage 返回时
-- 的有界估算——计量来源分列，可审计且不静默记零。预算判定时四列合计为
-- 当日已用。全部经员工自己的 RECORD 会话写入（与 employee_trigger 同权限
-- 形状）；日期切换后新一天自然生成新行，旧行保留作审计。
--
-- budget_signal_at 兼作"当日 budget-exhausted signal 只发一次"的 CAS 去重位：
-- runtime 用 UPSERT ... WHERE budget_signal_at IS NONE 原子抢占发送权，跨
-- 进程/跨重启也只赢一次。

DEFINE TABLE IF NOT EXISTS employee_token_usage SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.kind = "virtual",
    FOR update WHERE employee = $auth,
    FOR delete WHERE $auth.is_admin = true;

DEFINE FIELD IF NOT EXISTS employee ON TABLE employee_token_usage TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS day ON TABLE employee_token_usage TYPE string
  ASSERT $value != "" AND string::len($value) <= 16;
DEFINE FIELD IF NOT EXISTS provider_input_tokens ON TABLE employee_token_usage TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS provider_output_tokens ON TABLE employee_token_usage TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS estimated_input_tokens ON TABLE employee_token_usage TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS estimated_output_tokens ON TABLE employee_token_usage TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS calls ON TABLE employee_token_usage TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS budget_signal_at ON TABLE employee_token_usage TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE employee_token_usage TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE employee_token_usage TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS employee_token_usage_day_unique ON TABLE employee_token_usage COLUMNS employee, day UNIQUE;
