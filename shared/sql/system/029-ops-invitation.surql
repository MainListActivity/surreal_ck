-- G2 运营代办开通：「IdP 邀请 + workspace bootstrap + 免费权益」组合动作的
-- 邀请记录与审计锚点。只新增结构，不改写既有数据。
-- 约定：activation_url / 邀请 token 属一次性凭证，永不入库；仅记
-- activation_url_issued 布尔事实。不可变动作事实分别由 IdP 审计、
-- product_entitlement 审计（assign/grant）与 ai_ledger_entry（grant）承担，
-- 本表记录组合结果与幂等锚点（processing → completed/failed 仅迁移一次）。

DEFINE TABLE IF NOT EXISTS ops_invitation SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS idempotency_key ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS operator_subject ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS authorized_capability ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS email ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS workspace_slug ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS workspace_name ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS plan_key ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON ops_invitation TYPE string;
DEFINE FIELD IF NOT EXISTS status ON ops_invitation TYPE string
  ASSERT $value INSIDE ["processing", "completed", "failed"];

-- 各步结果（完成/失败一次性补齐；processing 期间为 NONE）。
DEFINE FIELD IF NOT EXISTS idp_user_id ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS idp_user_status ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS user_outcome ON ops_invitation TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["created", "reused"];
DEFINE FIELD IF NOT EXISTS workspace_db ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS workspace_outcome ON ops_invitation TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["created", "reused"];
DEFINE FIELD IF NOT EXISTS product_revision ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content_assigned ON ops_invitation TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS ai_allowance ON ops_invitation TYPE option<object>;
DEFINE FIELD IF NOT EXISTS ai_allowance.kind ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS ai_allowance.amount ON ops_invitation TYPE option<int>;
DEFINE FIELD IF NOT EXISTS ai_allowance.period_key ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS ai_allowance.expires_at ON ops_invitation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS ai_allowance.bucket ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS delivery_channel ON ops_invitation TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["activation_url", "email", "none"];
DEFINE FIELD IF NOT EXISTS activation_url_issued ON ops_invitation TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS error_code ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_message ON ops_invitation TYPE option<string>;

DEFINE FIELD IF NOT EXISTS created_at ON ops_invitation TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS completed_at ON ops_invitation TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS ops_invitation_key_unique ON ops_invitation COLUMNS idempotency_key UNIQUE;
DEFINE INDEX IF NOT EXISTS ops_invitation_email_idx ON ops_invitation COLUMNS email;
