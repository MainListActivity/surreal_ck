-- FV06 第二阶段 B 档独立采样包络；只新增结构，既有 attempt/window 与 30 次账本不回填、不改写。
DEFINE TABLE IF NOT EXISTS internal_ai_envelope SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS goal ON internal_ai_envelope TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS max_attempts ON internal_ai_envelope TYPE int ASSERT $value = 20 READONLY;
DEFINE FIELD IF NOT EXISTS total_nano_usd ON internal_ai_envelope TYPE int ASSERT $value = 700000000 READONLY;
DEFINE FIELD IF NOT EXISTS per_attempt_nano_usd ON internal_ai_envelope TYPE int ASSERT $value = 35000000 READONLY;
DEFINE FIELD IF NOT EXISTS expires_at ON internal_ai_envelope TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS approval_refs ON internal_ai_envelope TYPE array<string> READONLY;
DEFINE FIELD IF NOT EXISTS attempts ON internal_ai_envelope TYPE int DEFAULT 0 ASSERT $value >= 0 AND $value <= 20;
DEFINE FIELD IF NOT EXISTS committed_attempts ON internal_ai_envelope TYPE int DEFAULT 0 ASSERT $value >= 0 AND $value <= 20;
DEFINE FIELD IF NOT EXISTS allocated_nano_usd ON internal_ai_envelope TYPE int DEFAULT 0 ASSERT $value >= 0 AND $value <= 700000000;
DEFINE FIELD IF NOT EXISTS reserved ON internal_ai_envelope TYPE int DEFAULT 0 ASSERT $value >= 0 AND $value <= 700000000;
DEFINE FIELD IF NOT EXISTS spent ON internal_ai_envelope TYPE int DEFAULT 0 ASSERT $value >= 0 AND $value <= 700000000;
DEFINE FIELD IF NOT EXISTS revision ON internal_ai_envelope TYPE int DEFAULT 0 ASSERT $value >= 0;

-- 新窗口标识与逐次 attempt 归属只用于 B 档；旧行保持 NONE，不扫描或回填历史。
DEFINE FIELD IF NOT EXISTS envelope ON internal_ai_window TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS envelope ON internal_ai_attempt TYPE option<string> READONLY;
