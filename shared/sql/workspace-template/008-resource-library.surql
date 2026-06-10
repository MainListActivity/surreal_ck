-- 资源库表（自 pre-pivot schema/main.surql 移植，RR-013）。
-- 每个 workspace 是独立 SurrealDB database：这些表不带 workspace 字段，
-- 跨 workspace 隔离靠 db 边界；sync 时代的本地伴随链接表与 origin session 字段
-- 不再移植，resource ↔ session 关联由 created_resources 承载。

-- 检索过程：私有于发起者，管理员可审计。
DEFINE TABLE IF NOT EXISTS research_session SCHEMAFULL
  PERMISSIONS
    FOR select WHERE created_by = $auth OR $auth.is_admin = true,
    FOR create WHERE $auth != NONE,
    FOR update, delete WHERE created_by = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS originating_run_id ON TABLE research_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS query ON TABLE research_session TYPE string;
DEFINE FIELD IF NOT EXISTS context ON TABLE research_session TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS resource_type ON TABLE research_session TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE research_session TYPE string
  ASSERT $value INSIDE ["open", "completed", "cancelled"];
DEFINE FIELD IF NOT EXISTS created_resources ON TABLE research_session TYPE array<record<resource_item>> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_by ON TABLE research_session TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE research_session TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE research_session TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE research_session TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cancelled_at ON TABLE research_session TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS research_session_status ON TABLE research_session COLUMNS status;
DEFINE INDEX IF NOT EXISTS research_session_originating_run ON TABLE research_session COLUMNS originating_run_id;

-- 共享资源库：同 workspace 成员可读写，删除仅管理员。
DEFINE TABLE IF NOT EXISTS resource_item SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update WHERE $auth != NONE,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS resource_type ON TABLE resource_item TYPE string;
DEFINE FIELD IF NOT EXISTS title ON TABLE resource_item TYPE string;
DEFINE FIELD IF NOT EXISTS summary ON TABLE resource_item TYPE string;
DEFINE FIELD IF NOT EXISTS source_url ON TABLE resource_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source_title ON TABLE resource_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS evidence ON TABLE resource_item TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS tags ON TABLE resource_item TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS structured_payload ON TABLE resource_item TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS quality ON TABLE resource_item TYPE string
  ASSERT $value INSIDE ["user-confirmed", "ai-draft", "imported", "deprecated"];
DEFINE FIELD IF NOT EXISTS confidence ON TABLE resource_item TYPE option<number>;
DEFINE FIELD IF NOT EXISTS source_trust ON TABLE resource_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content_hash ON TABLE resource_item TYPE string;
DEFINE FIELD IF NOT EXISTS evidence_hash ON TABLE resource_item TYPE string;
DEFINE FIELD IF NOT EXISTS source_hash ON TABLE resource_item TYPE string;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE resource_item TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE resource_item TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE resource_item TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS resource_item_type ON TABLE resource_item COLUMNS resource_type;
DEFINE INDEX IF NOT EXISTS resource_item_content_hash ON TABLE resource_item COLUMNS content_hash;
DEFINE INDEX IF NOT EXISTS resource_item_evidence_hash ON TABLE resource_item COLUMNS evidence_hash;
DEFINE INDEX IF NOT EXISTS resource_item_source_hash ON TABLE resource_item COLUMNS source_hash;

-- 向量索引（HNSW）的 DIMENSION 随 profile 而变，不在模板静态定义，
-- 由检索实现按当前 profile 建索引。
DEFINE TABLE IF NOT EXISTS resource_embedding SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update WHERE $auth != NONE,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS resource ON TABLE resource_embedding TYPE record<resource_item>;
DEFINE FIELD IF NOT EXISTS profile_key ON TABLE resource_embedding TYPE string;
DEFINE FIELD IF NOT EXISTS provider ON TABLE resource_embedding TYPE string;
DEFINE FIELD IF NOT EXISTS model ON TABLE resource_embedding TYPE string;
DEFINE FIELD IF NOT EXISTS dimensions ON TABLE resource_embedding TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS profile_version ON TABLE resource_embedding TYPE string;
DEFINE FIELD IF NOT EXISTS embedding_text_hash ON TABLE resource_embedding TYPE string;
DEFINE FIELD IF NOT EXISTS vector ON TABLE resource_embedding TYPE array<float> DEFAULT [];
DEFINE FIELD IF NOT EXISTS status ON TABLE resource_embedding TYPE string
  ASSERT $value INSIDE ["disabled", "pending", "indexed", "failed", "stale"];
DEFINE FIELD IF NOT EXISTS error_summary ON TABLE resource_embedding TYPE option<string>;
DEFINE FIELD IF NOT EXISTS indexed_at ON TABLE resource_embedding TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE resource_embedding TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE resource_embedding TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS resource_embedding_resource_profile_unique ON TABLE resource_embedding COLUMNS resource, profile_key UNIQUE;
DEFINE INDEX IF NOT EXISTS resource_embedding_profile_status ON TABLE resource_embedding COLUMNS profile_key, status;
DEFINE INDEX IF NOT EXISTS resource_embedding_resource ON TABLE resource_embedding COLUMNS resource;

-- 每 db 单例：约定固定 record id `workspace_embedding_profile:default`。
DEFINE TABLE IF NOT EXISTS workspace_embedding_profile SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS provider ON TABLE workspace_embedding_profile TYPE string;
DEFINE FIELD IF NOT EXISTS model ON TABLE workspace_embedding_profile TYPE string;
DEFINE FIELD IF NOT EXISTS dimensions ON TABLE workspace_embedding_profile TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS version ON TABLE workspace_embedding_profile TYPE string;
DEFINE FIELD IF NOT EXISTS base_url ON TABLE workspace_embedding_profile TYPE option<string>;
DEFINE FIELD IF NOT EXISTS api_format ON TABLE workspace_embedding_profile TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["openai-compatible", "openai-responses", "anthropic"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_embedding_profile TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workspace_embedding_profile TYPE datetime VALUE time::now();
