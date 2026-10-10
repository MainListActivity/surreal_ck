-- 内部AI受审登记：不可变审计 revision + 身份绑定。只新增结构，不回填/删除既有生产数据。
-- 与 034-internal-ai-budget.surql 同库；登记侧只写这里与 internal_ai_activity/binding 的既有字段。
DEFINE TABLE IF NOT EXISTS internal_ai_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS activity ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS revision ON internal_ai_revision TYPE int
  READONLY
  ASSERT $value > 0;
-- disabled 只允许登记；enabled 必须经显式 enable；revoked 保留历史并阻止新 run。
DEFINE FIELD IF NOT EXISTS state ON internal_ai_revision TYPE string
  READONLY
  ASSERT $value INSIDE ["disabled", "enabled", "revoked"];
DEFINE FIELD IF NOT EXISTS proof_type ON internal_ai_revision TYPE string
  READONLY
  ASSERT $value INSIDE ["development-disabled", "approved-service"];
DEFINE FIELD IF NOT EXISTS goal ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS project ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS env ON internal_ai_revision TYPE string READONLY;
-- 操作者/原因/目标/配置摘要/批准引用：审计必需，缺一即拒登记。
DEFINE FIELD IF NOT EXISTS operator ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS reason ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS request_task ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS proof_jti ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS source_jti ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS manifest_hash ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS document_hash ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS configuration_digest ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS identities_digest ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS approval_task ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS approval_version ON internal_ai_revision TYPE option<int>
  READONLY;
DEFINE FIELD IF NOT EXISTS approval_action ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS approval_audit_id ON internal_ai_revision TYPE option<string>
  READONLY;
-- 脱敏供应商资料引用：对外只出现 accountRef，不出现账单身份/密钥。
DEFINE FIELD IF NOT EXISTS account_ref ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS endpoint ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS model ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS price_revision ON internal_ai_revision TYPE string
  READONLY;
DEFINE FIELD IF NOT EXISTS currency ON internal_ai_revision TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS balance_nano_usd ON internal_ai_revision TYPE option<int>
  READONLY;
DEFINE FIELD IF NOT EXISTS balance_sampled_at ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS evidence_expires_at ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS auto_topup_disabled ON internal_ai_revision TYPE bool
  READONLY;
DEFINE FIELD IF NOT EXISTS service_approved ON internal_ai_revision TYPE bool
  READONLY;
-- 公司状态能力秘密只存哈希；明文不落库。
DEFINE FIELD IF NOT EXISTS status_capability_hash ON internal_ai_revision TYPE option<string>
  READONLY;
DEFINE FIELD IF NOT EXISTS gaps ON internal_ai_revision TYPE array<string>
  DEFAULT []
  READONLY;
-- 前后读回：脱敏快照，供审计比对"这次改动把活动从什么状态改成什么状态"。
DEFINE FIELD IF NOT EXISTS before ON internal_ai_revision TYPE option<object> FLEXIBLE
  READONLY;
DEFINE FIELD IF NOT EXISTS after ON internal_ai_revision TYPE option<object> FLEXIBLE
  READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON internal_ai_revision TYPE datetime
  READONLY
  DEFAULT time::now();
-- 同一活动 revision 单调唯一：重复登记走幂等，冲突拒绝。
DEFINE INDEX IF NOT EXISTS internal_ai_revision_seq ON internal_ai_revision COLUMNS activity, revision
  UNIQUE;
DEFINE INDEX IF NOT EXISTS internal_ai_revision_jti ON internal_ai_revision COLUMNS proof_jti
  UNIQUE;
DEFINE INDEX IF NOT EXISTS internal_ai_revision_source ON internal_ai_revision COLUMNS source_jti;

DEFINE TABLE IF NOT EXISTS internal_ai_identity SCHEMAFULL PERMISSIONS NONE;
-- 只存身份哈希与投影，不存 subject 原文：操作者无法据此伪造或反向识别客户身份。
DEFINE FIELD IF NOT EXISTS identity_hash ON internal_ai_identity TYPE string;
DEFINE FIELD IF NOT EXISTS activity ON internal_ai_identity TYPE string;
DEFINE FIELD IF NOT EXISTS revision ON internal_ai_identity TYPE int;
DEFINE FIELD IF NOT EXISTS alias ON internal_ai_identity TYPE string
  ASSERT $value INSIDE ["LCA04_REMOVABLE", "LCA04_MEMBER"];
DEFINE FIELD IF NOT EXISTS space_id ON internal_ai_identity TYPE string;
DEFINE FIELD IF NOT EXISTS database ON internal_ai_identity TYPE string;
DEFINE FIELD IF NOT EXISTS workspace_role ON internal_ai_identity TYPE string
  ASSERT $value INSIDE ["admin", "participant"];
-- billingRole 是契约二元词表（owner|member），不是 billing_account_member.role 透传。
DEFINE FIELD IF NOT EXISTS billing_role ON internal_ai_identity TYPE string
  ASSERT $value INSIDE ["owner", "member"];
DEFINE FIELD IF NOT EXISTS billing_account_ref ON internal_ai_identity TYPE string;
-- 撤销是持久标记不是删除：撤销后同一身份新旧 run/key 一律拒绝。
DEFINE FIELD IF NOT EXISTS revoked ON internal_ai_identity TYPE bool
  DEFAULT false;
DEFINE FIELD IF NOT EXISTS registered_at ON internal_ai_identity TYPE datetime
  READONLY
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS revoked_at ON internal_ai_identity TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS revoke_reason ON internal_ai_identity TYPE option<string>;
DEFINE INDEX IF NOT EXISTS internal_ai_identity_binding ON internal_ai_identity COLUMNS identity_hash
  UNIQUE;
DEFINE INDEX IF NOT EXISTS internal_ai_identity_activity ON internal_ai_identity COLUMNS activity;

-- 门禁消费的绑定表追加审计字段（纯新增 option 字段，既有行与 034 语义不变）。
DEFINE FIELD IF NOT EXISTS alias ON internal_ai_binding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS space_id ON internal_ai_binding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS database ON internal_ai_binding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS workspace_role ON internal_ai_binding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS billing_role ON internal_ai_binding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS billing_account_ref ON internal_ai_binding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS revision ON internal_ai_binding TYPE option<int>;
DEFINE FIELD IF NOT EXISTS revoked_at ON internal_ai_binding TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS revoke_reason ON internal_ai_binding TYPE option<string>;

DEFINE FIELD IF NOT EXISTS proof_expires_at ON internal_ai_revision TYPE int
  READONLY;
DEFINE FIELD IF NOT EXISTS proof_expires_at ON internal_ai_activity TYPE option<int>;
DEFINE FIELD IF NOT EXISTS registration_jti ON internal_ai_activity TYPE option<string>;
