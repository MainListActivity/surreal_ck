-- 平台密封密钥仓：服务端的运行时密文存储（如 IdP provision token）。
-- 只新增结构，不改写既有数据。
-- 约定：secret 明文永不入库；envelope 为 AES-256-GCM 封套 JSON
--（v / alg / iv / tag / data），解封密钥仅存在于 server 进程环境
-- PLATFORM_SECRET_KEY，员工与库内任何 access 均不可读（PERMISSIONS NONE，
-- 仅 root 维护会话可写）。轮换动作由 platform_secret_event 留审计锚点，
-- 事件只记身份与元数据，不记明文或密文差异。

DEFINE TABLE IF NOT EXISTS platform_secret SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS name ON platform_secret TYPE string;
DEFINE FIELD IF NOT EXISTS envelope ON platform_secret TYPE string;
DEFINE FIELD IF NOT EXISTS purpose ON platform_secret TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_by ON platform_secret TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON platform_secret TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON platform_secret TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS platform_secret_name_unique ON platform_secret COLUMNS name UNIQUE;

DEFINE TABLE IF NOT EXISTS platform_secret_event SCHEMAFULL PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS secret_name ON platform_secret_event TYPE string;
DEFINE FIELD IF NOT EXISTS action ON platform_secret_event TYPE string
  ASSERT $value INSIDE ["rotate", "seed"];
DEFINE FIELD IF NOT EXISTS actor_subject ON platform_secret_event TYPE string;
DEFINE FIELD IF NOT EXISTS source ON platform_secret_event TYPE string;
DEFINE FIELD IF NOT EXISTS detail ON platform_secret_event TYPE option<object>;
DEFINE FIELD IF NOT EXISTS occurred_at ON platform_secret_event TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS platform_secret_event_name_idx ON platform_secret_event COLUMNS secret_name;
