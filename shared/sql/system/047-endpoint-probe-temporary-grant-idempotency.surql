-- FV06 探针临时授权幂等请求记录（round-01 修复）：只新增独立表，不改写
-- platform_operator / platform_operator_capability / platform_operator_temporary_grant 行。
--
-- 语义：
-- - 每次授予/撤回携带持久 idempotencyKey；同一 (subject, capability, key) 只能落一条。
-- - 同键重放只返回当前状态，不重新计算 not_after；撤回、过期、重启后亦然。
-- - 重新授予必须使用新的 idempotencyKey，并携带当前 expectedVersion。
-- - 与临时授权行在同一事务内写入；唯一索引用于并发同键请求的原子去重。

DEFINE TABLE IF NOT EXISTS platform_operator_temporary_grant_request SCHEMAFULL
  PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS subject ON TABLE platform_operator_temporary_grant_request TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS capability ON TABLE platform_operator_temporary_grant_request TYPE string
  ASSERT $value = "internal-ai.endpoint-probe";
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE platform_operator_temporary_grant_request TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS operation ON TABLE platform_operator_temporary_grant_request TYPE string
  ASSERT $value INSIDE ["grant", "revoke"];
DEFINE FIELD IF NOT EXISTS result_version ON TABLE platform_operator_temporary_grant_request TYPE option<int>
  ASSERT $value = NONE OR $value >= 1;
DEFINE FIELD IF NOT EXISTS result_not_after ON TABLE platform_operator_temporary_grant_request TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE platform_operator_temporary_grant_request TYPE datetime
  VALUE time::now();

DEFINE INDEX IF NOT EXISTS platform_operator_temporary_grant_request_unique
  ON TABLE platform_operator_temporary_grant_request
  COLUMNS subject, capability, idempotency_key UNIQUE;
