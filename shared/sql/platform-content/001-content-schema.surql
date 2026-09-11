-- 平台法律内容库 v1。
--
-- 该库位于部署级 _system database；客户 workspace database 不复制正文。
-- 迁移/权限由 server/src/content/schema.ts 与 SCK-LCM-03 的受限 publisher access
-- 管理。所有历史版本、校验修订及发布事件先按不可变审计记录设计。

DEFINE TABLE IF NOT EXISTS platform_content_schema_version SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS version ON TABLE platform_content_schema_version TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS applied_at ON TABLE platform_content_schema_version TYPE datetime
  DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS content_source SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS source_key ON TABLE content_source TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE content_source TYPE string;
DEFINE FIELD IF NOT EXISTS jurisdiction ON TABLE content_source TYPE option<string>;
DEFINE FIELD IF NOT EXISTS base_url ON TABLE content_source TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE content_source TYPE string
  ASSERT $value INSIDE ["active", "inactive"];
DEFINE FIELD IF NOT EXISTS allowed_actions ON TABLE content_source TYPE array<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_source TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE content_source TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS content_source_key_unique ON TABLE content_source COLUMNS source_key
  UNIQUE;

DEFINE TABLE IF NOT EXISTS source_license_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS source ON TABLE source_license_revision TYPE record<content_source>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE source_license_revision TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS license_kind ON TABLE source_license_revision TYPE string;
DEFINE FIELD IF NOT EXISTS allowed_actions ON TABLE source_license_revision TYPE array<string>;
DEFINE FIELD IF NOT EXISTS effective_from ON TABLE source_license_revision TYPE datetime;
DEFINE FIELD IF NOT EXISTS effective_until ON TABLE source_license_revision TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS evidence_url ON TABLE source_license_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS evidence_text ON TABLE source_license_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE source_license_revision TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE source_license_revision TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS source_license_revision_unique ON TABLE source_license_revision COLUMNS source, revision
  UNIQUE;
DEFINE EVENT IF NOT EXISTS source_license_revision_immutable ON TABLE source_license_revision
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:source_license_revision";
  };

DEFINE TABLE IF NOT EXISTS content_item SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS public_id ON TABLE content_item TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON TABLE content_item TYPE string
  ASSERT $value INSIDE ["legislation", "judicial_document"];
DEFINE FIELD IF NOT EXISTS current_version ON TABLE content_item TYPE option<record<content_version>>;
DEFINE FIELD IF NOT EXISTS publication_status ON TABLE content_item TYPE string
  ASSERT $value INSIDE ["unpublished", "published", "withdrawn"];
DEFINE FIELD IF NOT EXISTS publication_revision ON TABLE content_item TYPE int
  DEFAULT 1
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_item TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE content_item TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS content_item_public_id_unique ON TABLE content_item COLUMNS public_id
  UNIQUE;
DEFINE INDEX IF NOT EXISTS content_item_kind_status ON TABLE content_item COLUMNS kind, publication_status;

DEFINE TABLE IF NOT EXISTS content_source_record SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS source ON TABLE content_source_record TYPE record<content_source>;
DEFINE FIELD IF NOT EXISTS record_key ON TABLE content_source_record TYPE string;
DEFINE FIELD IF NOT EXISTS item ON TABLE content_source_record TYPE record<content_item>;
DEFINE FIELD IF NOT EXISTS source_url ON TABLE content_source_record TYPE string;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE content_source_record TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE content_source_record TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS content_source_record_source_key_unique ON TABLE content_source_record COLUMNS source, record_key
  UNIQUE;
DEFINE INDEX IF NOT EXISTS content_source_record_item ON TABLE content_source_record COLUMNS item;

DEFINE TABLE IF NOT EXISTS content_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS public_id ON TABLE content_version TYPE string;
DEFINE FIELD IF NOT EXISTS item ON TABLE content_version TYPE record<content_item>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE content_version TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS version_label ON TABLE content_version TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source ON TABLE content_version TYPE record<content_source>;
DEFINE FIELD IF NOT EXISTS source_url ON TABLE content_version TYPE string;
DEFINE FIELD IF NOT EXISTS source_record_key ON TABLE content_version TYPE option<string>;
DEFINE FIELD IF NOT EXISTS fetched_at ON TABLE content_version TYPE datetime;
DEFINE FIELD IF NOT EXISTS published_at ON TABLE content_version TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at_source ON TABLE content_version TYPE option<datetime>;
-- SurrealDB 当前 schema 类型没有 date；日期精度由契约层保留为 YYYY-MM-DD string。
DEFINE FIELD IF NOT EXISTS published_on ON TABLE content_version TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_on ON TABLE content_version TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source_date_text ON TABLE content_version TYPE option<string>;
DEFINE FIELD IF NOT EXISTS title ON TABLE content_version TYPE string;
DEFINE FIELD IF NOT EXISTS body_text ON TABLE content_version TYPE string;
DEFINE FIELD IF NOT EXISTS body_sha256 ON TABLE content_version TYPE string;
DEFINE FIELD IF NOT EXISTS source_form ON TABLE content_version TYPE string
  ASSERT $value INSIDE [
    "full_text",
    "excerpt",
    "case_summary",
    "amendment_notice",
  ];
DEFINE FIELD IF NOT EXISTS evidence ON TABLE content_version TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS field_issues ON TABLE content_version TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS processing ON TABLE content_version TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS content_kind_payload ON TABLE content_version TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS received_at ON TABLE content_version TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE content_version TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_version TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS content_version_revision_unique ON TABLE content_version COLUMNS item, revision
  UNIQUE;
DEFINE INDEX IF NOT EXISTS content_version_public_id_unique ON TABLE content_version COLUMNS public_id
  UNIQUE;
DEFINE INDEX IF NOT EXISTS content_version_body_sha256 ON TABLE content_version COLUMNS body_sha256;
DEFINE EVENT IF NOT EXISTS content_version_immutable ON TABLE content_version
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:content_version";
  };

DEFINE TABLE IF NOT EXISTS legal_article_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS regulation_version ON TABLE legal_article_version TYPE record<content_version>;
DEFINE FIELD IF NOT EXISTS local_key ON TABLE legal_article_version TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE legal_article_version TYPE string;
DEFINE FIELD IF NOT EXISTS hierarchy_path ON TABLE legal_article_version TYPE array<string>;
DEFINE FIELD IF NOT EXISTS body_text ON TABLE legal_article_version TYPE string;
DEFINE FIELD IF NOT EXISTS locator ON TABLE legal_article_version TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS source_locator ON TABLE legal_article_version TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS effective_on ON TABLE legal_article_version TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE legal_article_version TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS legal_article_version_unique ON TABLE legal_article_version COLUMNS regulation_version, local_key
  UNIQUE;
DEFINE EVENT IF NOT EXISTS legal_article_version_immutable ON TABLE legal_article_version
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:legal_article_version";
  };

DEFINE TABLE IF NOT EXISTS content_citation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS document_version ON TABLE content_citation TYPE record<content_version>;
DEFINE FIELD IF NOT EXISTS local_citation_key ON TABLE content_citation TYPE string;
DEFINE FIELD IF NOT EXISTS relation_kind ON TABLE content_citation TYPE string
  ASSERT $value INSIDE ["explicit_citation", "inferred_relation"];
DEFINE FIELD IF NOT EXISTS speaker ON TABLE content_citation TYPE string
  ASSERT $value INSIDE ["court", "party", "editor", "other", "unknown"];
DEFINE FIELD IF NOT EXISTS quoted_text ON TABLE content_citation TYPE string;
DEFINE FIELD IF NOT EXISTS locator ON TABLE content_citation TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS raw_law_name ON TABLE content_citation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS raw_article_label ON TABLE content_citation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS resolution ON TABLE content_citation TYPE string
  ASSERT $value INSIDE ["unresolved", "ambiguous", "proposed", "verified"];
DEFINE FIELD IF NOT EXISTS candidates ON TABLE content_citation TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS treatment ON TABLE content_citation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS treatment_evidence ON TABLE content_citation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_citation TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS content_citation_unique ON TABLE content_citation COLUMNS document_version, local_citation_key
  UNIQUE;
DEFINE EVENT IF NOT EXISTS content_citation_immutable ON TABLE content_citation
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:content_citation";
  };

DEFINE TABLE IF NOT EXISTS citation_resolution SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS citation ON TABLE citation_resolution TYPE record<content_citation>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE citation_resolution TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS status ON TABLE citation_resolution TYPE string
  ASSERT $value INSIDE ["unresolved", "ambiguous", "proposed", "verified"];
DEFINE FIELD IF NOT EXISTS candidates ON TABLE citation_resolution TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS evidence_ref ON TABLE citation_resolution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS verified_by_subject ON TABLE citation_resolution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE citation_resolution TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS citation_resolution_unique ON TABLE citation_resolution COLUMNS citation, revision
  UNIQUE;
DEFINE EVENT IF NOT EXISTS citation_resolution_immutable ON TABLE citation_resolution
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:citation_resolution";
  };

DEFINE TABLE IF NOT EXISTS cites_article TYPE RELATION SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS in ON TABLE cites_article TYPE record<content_citation>
  READONLY;
DEFINE FIELD IF NOT EXISTS out ON TABLE cites_article TYPE record<legal_article_version>
  READONLY;
DEFINE FIELD IF NOT EXISTS resolution_revision ON TABLE cites_article TYPE record<citation_resolution>
  READONLY;

DEFINE TABLE IF NOT EXISTS cites_legislation TYPE RELATION SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS in ON TABLE cites_legislation TYPE record<content_citation>
  READONLY;
DEFINE FIELD IF NOT EXISTS out ON TABLE cites_legislation TYPE record<content_version>
  READONLY;
DEFINE FIELD IF NOT EXISTS resolution_revision ON TABLE cites_legislation TYPE record<citation_resolution>
  READONLY;

DEFINE TABLE IF NOT EXISTS ingestion_batch SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS public_id ON TABLE ingestion_batch TYPE string;
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE ingestion_batch TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE ingestion_batch TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON TABLE ingestion_batch TYPE string;
DEFINE FIELD IF NOT EXISTS contract_version ON TABLE ingestion_batch TYPE string;
DEFINE FIELD IF NOT EXISTS request ON TABLE ingestion_batch TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS status ON TABLE ingestion_batch TYPE string
  ASSERT $value INSIDE [
    "received",
    "validating",
    "ready",
    "partially_validated",
    "rejected",
    "published",
  ];
DEFINE FIELD IF NOT EXISTS validation_revision ON TABLE ingestion_batch TYPE int
  DEFAULT 1
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS received_at ON TABLE ingestion_batch TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ingestion_batch TYPE datetime
  VALUE time::now();
DEFINE FIELD IF NOT EXISTS supersedes_batch ON TABLE ingestion_batch TYPE option<record<ingestion_batch>>;
DEFINE INDEX IF NOT EXISTS ingestion_batch_actor_idempotency_unique ON TABLE ingestion_batch COLUMNS actor_subject, idempotency_key
  UNIQUE;
DEFINE INDEX IF NOT EXISTS ingestion_batch_public_id_unique ON TABLE ingestion_batch COLUMNS public_id
  UNIQUE;

DEFINE TABLE IF NOT EXISTS platform_content_audit_event SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS kind ON TABLE platform_content_audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS batch ON TABLE platform_content_audit_event TYPE option<record<ingestion_batch>>;
DEFINE FIELD IF NOT EXISTS entry ON TABLE platform_content_audit_event TYPE option<record<ingestion_entry>>;
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE platform_content_audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS details ON TABLE platform_content_audit_event TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE platform_content_audit_event TYPE datetime
  DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS platform_content_audit_event_immutable ON TABLE platform_content_audit_event
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:platform_content_audit_event";
  };

DEFINE TABLE IF NOT EXISTS ingestion_entry SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS batch ON TABLE ingestion_entry TYPE record<ingestion_batch>;
DEFINE FIELD IF NOT EXISTS entry_key ON TABLE ingestion_entry TYPE string;
DEFINE FIELD IF NOT EXISTS operation ON TABLE ingestion_entry TYPE string
  ASSERT $value INSIDE ["upsert", "withdraw", "restore"];
DEFINE FIELD IF NOT EXISTS target_item ON TABLE ingestion_entry TYPE option<record<content_item>>;
DEFINE FIELD IF NOT EXISTS expected_version ON TABLE ingestion_entry TYPE option<record<content_version>>;
DEFINE FIELD IF NOT EXISTS payload ON TABLE ingestion_entry TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS issues ON TABLE ingestion_entry TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS status ON TABLE ingestion_entry TYPE string
  ASSERT $value INSIDE [
    "accepted",
    "duplicate",
    "rejected",
    "pending",
    "ready",
    "blocked",
    "published",
    "unchanged",
    "failed",
  ];
DEFINE FIELD IF NOT EXISTS publication_status ON TABLE ingestion_entry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ingestion_entry TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ingestion_entry_batch_key_unique ON TABLE ingestion_entry COLUMNS batch, entry_key
  UNIQUE;

DEFINE TABLE IF NOT EXISTS validation_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS entry ON TABLE validation_revision TYPE record<ingestion_entry>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE validation_revision TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS request_digest ON TABLE validation_revision TYPE string;
DEFINE FIELD IF NOT EXISTS rules_version ON TABLE validation_revision TYPE string;
DEFINE FIELD IF NOT EXISTS issues ON TABLE validation_revision TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS publishable ON TABLE validation_revision TYPE bool;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE validation_revision TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS validation_revision_unique ON TABLE validation_revision COLUMNS entry, revision
  UNIQUE;
DEFINE EVENT IF NOT EXISTS validation_revision_immutable ON TABLE validation_revision
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:validation_revision";
  };

DEFINE TABLE IF NOT EXISTS publication_request SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS public_id ON TABLE publication_request TYPE string;
DEFINE FIELD IF NOT EXISTS batch ON TABLE publication_request TYPE record<ingestion_batch>;
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE publication_request TYPE string;
DEFINE FIELD IF NOT EXISTS validation_revision ON TABLE publication_request TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS entry_keys ON TABLE publication_request TYPE array<string>;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE publication_request TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE publication_request TYPE string
  ASSERT $value INSIDE ["pending", "completed", "partial", "failed"];
DEFINE FIELD IF NOT EXISTS response ON TABLE publication_request TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE publication_request TYPE datetime
  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE publication_request TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS publication_request_idempotency_unique ON TABLE publication_request COLUMNS actor_subject, idempotency_key
  UNIQUE;
DEFINE INDEX IF NOT EXISTS publication_request_public_id_unique ON TABLE publication_request COLUMNS public_id
  UNIQUE;

DEFINE TABLE IF NOT EXISTS publication_item_result SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS request ON TABLE publication_item_result TYPE record<publication_request>;
DEFINE FIELD IF NOT EXISTS entry_key ON TABLE publication_item_result TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE publication_item_result TYPE string
  ASSERT $value INSIDE [
    "published",
    "unchanged",
    "blocked",
    "failed",
    "pending",
  ];
DEFINE FIELD IF NOT EXISTS version ON TABLE publication_item_result TYPE option<record<content_version>>;
DEFINE FIELD IF NOT EXISTS issues ON TABLE publication_item_result TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE publication_item_result TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS publication_item_result_unique ON TABLE publication_item_result COLUMNS request, entry_key
  UNIQUE;

DEFINE TABLE IF NOT EXISTS publication_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS request ON TABLE publication_event TYPE record<publication_request>;
DEFINE FIELD IF NOT EXISTS entry ON TABLE publication_event TYPE record<ingestion_entry>;
DEFINE FIELD IF NOT EXISTS item ON TABLE publication_event TYPE option<record<content_item>>;
DEFINE FIELD IF NOT EXISTS version ON TABLE publication_event TYPE option<record<content_version>>;
DEFINE FIELD IF NOT EXISTS event_kind ON TABLE publication_event TYPE string
  ASSERT $value INSIDE ["published", "corrected", "withdrawn", "restored"];
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE publication_event TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON TABLE publication_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE publication_event TYPE datetime
  DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS publication_event_immutable ON TABLE publication_event
  WHEN $event = "UPDATE"
  OR $event = "DELETE"
  THEN {
    THROW "immutable-platform-content-record:publication_event";
  };

-- 客户检索只会读取这份已发布投影；内部 staging/审计表没有客户读权限。
DEFINE TABLE IF NOT EXISTS content_publication_projection SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS item ON TABLE content_publication_projection TYPE record<content_item>;
DEFINE FIELD IF NOT EXISTS version ON TABLE content_publication_projection TYPE record<content_version>;
DEFINE FIELD IF NOT EXISTS searchable_text ON TABLE content_publication_projection TYPE string;
DEFINE FIELD IF NOT EXISTS indexed_at ON TABLE content_publication_projection TYPE datetime;
DEFINE FIELD IF NOT EXISTS publication_revision ON TABLE content_publication_projection TYPE int
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_publication_projection TYPE datetime
  DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS content_publication_projection_item_unique ON TABLE content_publication_projection COLUMNS item
  UNIQUE;
DEFINE INDEX IF NOT EXISTS content_publication_projection_version ON TABLE content_publication_projection COLUMNS version;
