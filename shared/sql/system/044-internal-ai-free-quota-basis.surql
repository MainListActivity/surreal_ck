-- FV06 免费额度窗口契约 v3（magpie-window/v3）：免费额度依据 + 用尽即停。
-- 结构级变更，只新增，不回填、不改写、不删除任何既有行：
-- 既有窗口的 stop_reason/stopped_at 保持 NONE，status 既有取值原样保留。

-- 窗口终态增加 stopped（保留 039 的 DEFAULT "active"，仅扩展允许取值集合）。
DEFINE FIELD OVERWRITE status ON internal_ai_window TYPE string
  DEFAULT "active"
  ASSERT $value INSIDE ["active", "exhausted", "expired", "revoked", "stopped"];
-- 停止原因与停止时刻：仅 stopped 时由停止事务写入，故不设 READONLY（须能从 NONE 变为值）。
DEFINE FIELD IF NOT EXISTS stop_reason ON internal_ai_window TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE [
    "free-basis-expired",
    "free-basis-invalid",
    "route-drift",
    "served-model-drift",
    "usage-missing",
    "usage-invalid",
    "quota-exhausted",
    "billing-required",
    "provider-uncertain",
  ];
DEFINE FIELD IF NOT EXISTS stopped_at ON internal_ai_window TYPE option<datetime>;

-- 免费额度依据记录：内容寻址、不可变。记录 id = 规范化内容的 sha256，content 为 canonical JSON；
-- 其余列只为查询与核对，读取侧以 content 复算 hash 为准，任何列与 content 不一致即拒绝。
DEFINE TABLE IF NOT EXISTS internal_ai_free_basis SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS content ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS route_host ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS route_path ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS route_served_model ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS envelope ON internal_ai_free_basis TYPE string
  ASSERT $value = "fv06-b-2026-11-05"
  READONLY;
DEFINE FIELD IF NOT EXISTS effective_at ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS expires_at ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS operator ON internal_ai_free_basis TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS reason ON internal_ai_free_basis TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON internal_ai_free_basis TYPE datetime
  DEFAULT time::now()
  READONLY;
