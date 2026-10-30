-- FV06 远端窗口契约 v2（magpie-window/v2）：兼容公司已批准的 remote-magpie-evidence/1
-- 证据形状——远端 route.revision/digest/expiresAt 允许如实落库为 NONE（null+gap 由代码侧
-- 一一对应校验），观测快照摘要/采集时刻/本地新鲜度与远端元数据分层保存，绝不互相冒充。
-- 结构级变更：仅把三个 route 字段类型放宽为 option<string>（既有行保持原值，不回填、
-- 不改写、不删除任何数据；读取侧把 NONE 视为 v1 契约行）并新增远端分层字段。
-- 旧 30 次周期/旧批准索引与预算字段不在本迁移范围内，保持 039 原语义。

DEFINE FIELD OVERWRITE route_revision ON internal_ai_window TYPE option<string> READONLY;
DEFINE FIELD OVERWRITE route_digest ON internal_ai_window TYPE option<string>
  ASSERT $value = NONE OR string::len($value) = 64 READONLY;
DEFINE FIELD OVERWRITE route_expires_at ON internal_ai_window TYPE option<string> READONLY;

-- 契约版本：新写入行带 "magpie-window/v1" 或 "magpie-window/v2"；既有行 NONE 视为 v1。
DEFINE FIELD IF NOT EXISTS contract_version ON internal_ai_window TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS evidence_version ON internal_ai_window TYPE option<string> READONLY;
-- 观测层：快照摘要与采集时刻是本地观测证据，绝不写入 route_digest/route_expires_at。
DEFINE FIELD IF NOT EXISTS observation_captured_at ON internal_ai_window TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS observation_digest ON internal_ai_window TYPE option<string>
  ASSERT $value = NONE OR string::len($value) = 64 READONLY;
DEFINE FIELD IF NOT EXISTS routing_configuration_verified ON internal_ai_window TYPE option<bool> READONLY;
-- 冻结的受控 provider：v2 行与请求路径的 providerId 精确比对；NONE 保持旧 openai 规则。
DEFINE FIELD IF NOT EXISTS route_provider ON internal_ai_window TYPE option<string> READONLY;
-- 缺口声明 [{field, reason}]：与 route.* 的 null 一一对应；元素子键显式声明
-- （SCHEMAFULL 下数组元素 object 同样严格，FLEXIBLE 不覆盖嵌套），
-- 出现的字段集合由代码侧 zod + 一一对应校验限定。
DEFINE FIELD IF NOT EXISTS route_gaps ON internal_ai_window TYPE option<array<object>> READONLY;
DEFINE FIELD IF NOT EXISTS route_gaps.*.field ON internal_ai_window TYPE string;
DEFINE FIELD IF NOT EXISTS route_gaps.*.reason ON internal_ai_window TYPE string;
-- 本地新鲜度层：证据期 = 采集 + 7200s，独立于远端 route_expires_at。
DEFINE FIELD IF NOT EXISTS expiry_basis ON internal_ai_window TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS local_freshness_expires_at ON internal_ai_window TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS source_expires_at ON internal_ai_window TYPE option<array> READONLY;
-- 价目证据层：远端目录修订与人工复核状态如实记录；reviewed=false 时 price_basis 只能是
-- unknown，请求门禁闭锁，目录 0/0 永不自动等于 free-evidence。
DEFINE FIELD IF NOT EXISTS pricing_reviewed ON internal_ai_window TYPE option<bool> READONLY;
DEFINE FIELD IF NOT EXISTS pricing_evidence_revision ON internal_ai_window TYPE option<string> READONLY;
