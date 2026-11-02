-- FV06 探针临时授权（32c34822）：只新增独立临时授权表，不改写既有
-- platform_operator / platform_operator_capability 行，也不授予任何主体永久能力。
--
-- 语义：
-- - 仅服务 internal-ai.endpoint-probe；不引入通用任意能力管理。
-- - 唯一索引按 (subject, capability) —— 同一主体同一能力同时最多一条记录；
--   重新授予必须先撤回旧行，或在已撤回/已过期行上覆盖写入新的 not_after。
-- - 到期判定在权限检查时即时完成（not_after <= now），不依赖 sweep。
-- - seedPlatformOperators 不读写本表，因此后续 seed / 重启不会把临时权限补回永久表。

DEFINE TABLE IF NOT EXISTS platform_operator_temporary_grant SCHEMAFULL
  PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS subject ON TABLE platform_operator_temporary_grant TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS capability ON TABLE platform_operator_temporary_grant TYPE string
  ASSERT $value = "internal-ai.endpoint-probe";
DEFINE FIELD IF NOT EXISTS status ON TABLE platform_operator_temporary_grant TYPE string
  ASSERT $value INSIDE ["active", "revoked"];
DEFINE FIELD IF NOT EXISTS granted_by_subject ON TABLE platform_operator_temporary_grant TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD IF NOT EXISTS granted_at ON TABLE platform_operator_temporary_grant TYPE datetime;
DEFINE FIELD IF NOT EXISTS not_after ON TABLE platform_operator_temporary_grant TYPE datetime;
DEFINE FIELD IF NOT EXISTS revoked_at ON TABLE platform_operator_temporary_grant TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS revoked_by_subject ON TABLE platform_operator_temporary_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS grant_reason ON TABLE platform_operator_temporary_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS revoke_reason ON TABLE platform_operator_temporary_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS version ON TABLE platform_operator_temporary_grant TYPE int DEFAULT 1
  ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE platform_operator_temporary_grant TYPE datetime
  VALUE time::now();

DEFINE INDEX IF NOT EXISTS platform_operator_temporary_grant_unique
  ON TABLE platform_operator_temporary_grant COLUMNS subject, capability UNIQUE;
