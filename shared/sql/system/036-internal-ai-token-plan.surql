-- 内部AI配额型供应商证据（reviewed-token-plan）：只新增表字段并放宽 revision.currency 为可空，
-- 不回填、不改写或删除既有生产数据；USD-only 余额契约与旧行语义不变。
-- 与 034/035 同库；activity 投影字段由 enable 写入，revision 侧沿用 035 的 READONLY 只增语义。

-- 证据类型判别：reviewed-service=USD 余额契约（默认）；reviewed-token-plan=官方配额计划，无 USD 余额语义。
DEFINE FIELD IF NOT EXISTS evidence_kind ON internal_ai_activity TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["reviewed-service", "reviewed-token-plan"];
DEFINE FIELD IF NOT EXISTS plan_name ON internal_ai_activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS plan_source_url ON internal_ai_activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS quota_unit ON internal_ai_activity TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["points", "requests"];
DEFINE FIELD IF NOT EXISTS quota_amount ON internal_ai_activity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS quota_window_seconds ON internal_ai_activity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS quota_remaining ON internal_ai_activity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS no_payment_instrument ON internal_ai_activity TYPE option<bool>;

-- revision 侧同名字段：脱敏配额快照进审计历史，READONLY 只增。
-- revision.evidence_kind 记录实际提交的证据文档类型（含 development-disabled）；activity.evidence_kind 只允许受审类型（启用时写入）。
DEFINE FIELD IF NOT EXISTS evidence_kind ON internal_ai_revision TYPE option<string>
  READONLY
  ASSERT $value = NONE OR $value INSIDE ["development-disabled", "reviewed-service", "reviewed-token-plan"];
DEFINE FIELD IF NOT EXISTS plan_name ON internal_ai_revision TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS plan_source_url ON internal_ai_revision TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS quota_unit ON internal_ai_revision TYPE option<string>
  READONLY
  ASSERT $value = NONE OR $value INSIDE ["points", "requests"];
DEFINE FIELD IF NOT EXISTS quota_amount ON internal_ai_revision TYPE option<int> READONLY;
DEFINE FIELD IF NOT EXISTS quota_window_seconds ON internal_ai_revision TYPE option<int> READONLY;
DEFINE FIELD IF NOT EXISTS quota_remaining ON internal_ai_revision TYPE option<int> READONLY;
DEFINE FIELD IF NOT EXISTS no_payment_instrument ON internal_ai_revision TYPE option<bool> READONLY;
-- 证据哈希引用前缀（reviewed-document:<sha256> / token-plan:<sha256>）：与 activity.balance_source 对齐。
DEFINE FIELD IF NOT EXISTS balance_source ON internal_ai_revision TYPE option<string> READONLY;

-- currency 放宽为可空：配额型证据没有货币语义（USD-only 旧行仍为 "USD"，值不改写）。
-- IF NOT EXISTS 会跳过既有定义，必须用 OVERWRITE 显式放宽 string → option<string>。
DEFINE FIELD OVERWRITE currency ON internal_ai_revision TYPE option<string> READONLY;
