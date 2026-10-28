-- FV06 Magpie 受控新窗口：只新增结构，不回填、不改写或删除既有生产数据。
-- 窗口是「新独立批准摘要 + 证据期 + 源预算 + 冻结路由/容量声明」的持久授权记录；
-- 旧单例周期 a7537d2c / f3974e8f 与旧批准 4fff2947 不得复活（代码侧拒绝，索引侧防重复）。
DEFINE TABLE IF NOT EXISTS internal_ai_window SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS activity ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS approval_digest ON internal_ai_window TYPE string
  ASSERT string::len($value) = 64 READONLY;
DEFINE FIELD IF NOT EXISTS approval_task ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS account_ref ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS evidence_expires_at ON internal_ai_window TYPE string READONLY;
-- 源预算：创建时从「30 - 全部历史已用(含 failed/uncertain)」扣减后的新窗口上限。
DEFINE FIELD IF NOT EXISTS attempt_limit ON internal_ai_window TYPE int
  ASSERT $value > 0 AND $value <= 30 READONLY;
DEFINE FIELD IF NOT EXISTS source_budget_nano_usd ON internal_ai_window TYPE int
  ASSERT $value > 0 AND $value <= 1000000000 READONLY;
DEFINE FIELD IF NOT EXISTS per_attempt_nano_usd ON internal_ai_window TYPE int
  ASSERT $value > 0 AND $value <= 100000000 READONLY;
DEFINE FIELD IF NOT EXISTS attempts ON internal_ai_window TYPE int DEFAULT 0
  ASSERT $value >= 0 AND $value <= 30;
DEFINE FIELD IF NOT EXISTS reserved ON internal_ai_window TYPE int DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS spent ON internal_ai_window TYPE int DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS status ON internal_ai_window TYPE string DEFAULT "active"
  ASSERT $value INSIDE ["active", "exhausted", "expired", "revoked"];
DEFINE FIELD IF NOT EXISTS revision ON internal_ai_window TYPE int DEFAULT 1
  ASSERT $value >= 1;
-- 冻结的真实路由：revision/digest 由受控来源给出，产品不再推断。
DEFINE FIELD IF NOT EXISTS route_revision ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS route_digest ON internal_ai_window TYPE string
  ASSERT string::len($value) = 64 READONLY;
DEFINE FIELD IF NOT EXISTS requested_model ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS served_model ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS endpoint ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS account_binding ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS price_revision ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS price_basis ON internal_ai_window TYPE string
  ASSERT $value INSIDE ["free-evidence", "per-token", "subscription-amortized", "unknown"] READONLY;
DEFINE FIELD IF NOT EXISTS free_evidence_hash ON internal_ai_window TYPE option<string>
  ASSERT $value = NONE OR string::len($value) = 64 READONLY;
DEFINE FIELD IF NOT EXISTS amortized_nano_usd ON internal_ai_window TYPE option<int>
  ASSERT $value = NONE OR $value >= 0 READONLY;
DEFINE FIELD IF NOT EXISTS marginal_nano_usd ON internal_ai_window TYPE option<int>
  ASSERT $value = NONE OR $value >= 0 READONLY;
DEFINE FIELD IF NOT EXISTS max_output_tokens ON internal_ai_window TYPE int
  ASSERT $value > 0 AND $value <= 65536 READONLY;
DEFINE FIELD IF NOT EXISTS sampled_at ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS route_expires_at ON internal_ai_window TYPE string READONLY;
-- 容量声明只记录 9e44a95d 已批 scope，不据此创建表/字段/记录。
DEFINE FIELD IF NOT EXISTS capacity_database ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS capacity_tables ON internal_ai_window TYPE int
  ASSERT $value >= 3 AND $value <= 5 READONLY;
DEFINE FIELD IF NOT EXISTS capacity_fields ON internal_ai_window TYPE int
  ASSERT $value >= 1 AND $value <= 23 READONLY;
DEFINE FIELD IF NOT EXISTS capacity_records ON internal_ai_window TYPE int
  ASSERT $value >= 1 AND $value <= 24 READONLY;
DEFINE FIELD IF NOT EXISTS capacity_ttl_seconds ON internal_ai_window TYPE int
  ASSERT $value >= 1 AND $value <= 86400 READONLY;
DEFINE FIELD IF NOT EXISTS capacity_destructive ON internal_ai_window TYPE bool
  ASSERT $value = false READONLY;
DEFINE FIELD IF NOT EXISTS capacity_source ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS idempotency_key ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS payload_hash ON internal_ai_window TYPE string
  ASSERT string::len($value) = 64 READONLY;
DEFINE FIELD IF NOT EXISTS operator ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS reason ON internal_ai_window TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON internal_ai_window TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS bound_at ON internal_ai_window TYPE option<datetime>;

-- 同一活动同一批准只能建一个窗口；同一幂等键只能对应一个载荷。
DEFINE INDEX IF NOT EXISTS internal_ai_window_approval ON internal_ai_window
  COLUMNS activity, approval_digest UNIQUE;
DEFINE INDEX IF NOT EXISTS internal_ai_window_idempotency ON internal_ai_window
  COLUMNS activity, idempotency_key UNIQUE;

-- 活动侧只新增绑定字段：window_revision 兼作创建/绑定的串行化写锁。
DEFINE FIELD IF NOT EXISTS window_id ON internal_ai_activity TYPE option<record<internal_ai_window>>;
DEFINE FIELD IF NOT EXISTS window_revision ON internal_ai_activity TYPE int DEFAULT 0
  ASSERT $value >= 0;

-- 逐请求计量：保留 requested 与 served 的差异、路由快照、账号绑定、usage 原件、
-- 成本状态与订阅分摊/边际成本；未知一律 NONE，禁止 null 当 0。
DEFINE FIELD IF NOT EXISTS window ON internal_ai_attempt TYPE option<record<internal_ai_window>>;
DEFINE FIELD IF NOT EXISTS requested_model ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS served_model ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS route_revision ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS route_digest ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS account_binding ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS usage_raw ON internal_ai_attempt TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS cost_status ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS amortized_cost_nano_usd ON internal_ai_attempt TYPE option<int>;
DEFINE FIELD IF NOT EXISTS marginal_cost_nano_usd ON internal_ai_attempt TYPE option<int>;
DEFINE FIELD IF NOT EXISTS price_basis ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS failure_class ON internal_ai_attempt TYPE option<string>;
DEFINE FIELD IF NOT EXISTS route_drift ON internal_ai_attempt TYPE bool DEFAULT false;
