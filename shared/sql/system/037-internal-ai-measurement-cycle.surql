-- GM 批准的一次性零费率复测周期。只新增结构，旧 counters 与账本不回填、不重置。
DEFINE TABLE IF NOT EXISTS internal_ai_measurement_cycle SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS activity ON internal_ai_measurement_cycle TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS attempts ON internal_ai_measurement_cycle TYPE int
  DEFAULT 0
  ASSERT $value >= 0
  AND $value <= 30;
DEFINE FIELD IF NOT EXISTS attempt_limit ON internal_ai_measurement_cycle TYPE int
  ASSERT $value > 0
  AND $value <= 30
  READONLY;
DEFINE FIELD IF NOT EXISTS enabled_revision ON internal_ai_measurement_cycle TYPE int
  ASSERT $value > 0
  READONLY;
DEFINE FIELD IF NOT EXISTS approval_revision ON internal_ai_measurement_cycle TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS evidence_hash ON internal_ai_measurement_cycle TYPE string
  ASSERT string::len($value) = 64
  READONLY;
DEFINE FIELD IF NOT EXISTS expires_at ON internal_ai_measurement_cycle TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON internal_ai_measurement_cycle TYPE datetime
  DEFAULT time::now()
  READONLY;
DEFINE FIELD IF NOT EXISTS measurement_cycle ON internal_ai_attempt TYPE option<string>
  READONLY;
