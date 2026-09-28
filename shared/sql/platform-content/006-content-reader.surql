-- Content reader authorization; no customer content is copied to a workspace.
DEFINE TABLE content_projection_identity SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD active ON content_projection_identity TYPE bool;
DEFINE TABLE content_projection_credential SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD secret_hash ON content_projection_credential TYPE string;
DEFINE ACCESS content_projection_sync ON DATABASE TYPE RECORD
 SIGNIN {
  LET $identity = SELECT * FROM ONLY content_projection_identity:server;
  LET $credential = SELECT * FROM ONLY content_projection_credential:server;
  IF $identity.active != true OR !crypto::argon2::compare($credential.secret_hash, $pass) { THROW "projection credential rejected"; };
  RETURN $identity.id;
 }
 DURATION FOR TOKEN 15m, FOR SESSION 15m;

DEFINE TABLE content_authorization_projection SCHEMAFULL
 PERMISSIONS FOR select, create, update WHERE $auth = content_projection_identity:server FOR delete NONE;
DEFINE FIELD workspace_id ON content_authorization_projection TYPE string;
DEFINE FIELD revision ON content_authorization_projection TYPE string;
DEFINE FIELD revision_number ON content_authorization_projection TYPE int ASSERT $value > 0;
DEFINE FIELD digest ON content_authorization_projection TYPE string ASSERT string::starts_with($value, "sha256:");
DEFINE FIELD resolver_version ON content_authorization_projection TYPE string;
DEFINE FIELD collections ON content_authorization_projection TYPE array<string>;
DEFINE FIELD content_actions ON content_authorization_projection TYPE array<string> ASSERT array::all($value, |$v| $v IN ["browse", "search", "read", "cite", "export"]);
DEFINE FIELD ai_actions ON content_authorization_projection TYPE array<string> ASSERT array::all($value, |$v| $v IN ["research", "generate"]);
DEFINE FIELD allowed_subjects ON content_authorization_projection TYPE array<string>;
DEFINE FIELD confirmed_at ON content_authorization_projection TYPE datetime;
DEFINE FIELD confirmed_until ON content_authorization_projection TYPE datetime ASSERT $value <= time::now() + 15m;
DEFINE FIELD status ON content_authorization_projection TYPE string ASSERT $value IN ["active", "closed"];
DEFINE INDEX content_projection_workspace ON content_authorization_projection FIELDS workspace_id UNIQUE;

-- Explicit catalog assignment. No implicit mapping from a plan name or source.
DEFINE TABLE content_collection_binding SCHEMAFULL
 PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
 FOR create, update WHERE $auth = content_publisher_identity:server FOR delete NONE;
DEFINE FIELD item ON content_collection_binding TYPE record<content_item>;
DEFINE FIELD collections ON content_collection_binding TYPE array<string>;
DEFINE INDEX content_collection_item ON content_collection_binding FIELDS item UNIQUE;

DEFINE FUNCTION fn::content_reader_active() {
 IF $access != "content_reader" OR $token.exp <= time::unix(time::now()) { RETURN false; };
 LET $p = SELECT * FROM ONLY $auth;
 RETURN $p.status = "active" AND $p.workspace_id = $token.workspace_id
  AND $p.revision = $token.entitlement_revision AND $token.sub IN $p.allowed_subjects
  AND $p.confirmed_until > time::now() AND $p.confirmed_until <= $p.confirmed_at + 15m
  AND $p.confirmed_at <= time::now() AND $p.digest != NONE AND $p.resolver_version != NONE;
};

DEFINE FUNCTION fn::content_reader_action($version: record<content_version>, $action: string) {
 IF !fn::content_reader_active() { RETURN false; };
 LET $p = SELECT * FROM ONLY $auth;
 LET $v = SELECT * FROM ONLY $version;
 LET $item = SELECT * FROM ONLY $v.item;
 LET $source = SELECT * FROM ONLY $v.source;
 LET $license = (SELECT * FROM source_license_revision WHERE source = $v.source ORDER BY revision DESC LIMIT 1)[0];
 LET $binding = (SELECT * FROM content_collection_binding WHERE item = $v.item LIMIT 1)[0];
 IF $item.publication_status != "published" OR $source.status != "active"
  OR $license = NONE OR $license.effective_from > time::now()
  OR ($license.effective_until != NONE AND $license.effective_until <= time::now())
  OR array::len(array::intersect($p.collections, $binding.collections ?? [])) = 0 { RETURN false; };
 IF $action = "metadata" { RETURN ("browse" IN $p.content_actions AND "browse" IN $license.allowed_actions) OR ("search" IN $p.content_actions AND "search" IN $license.allowed_actions); };
 IF $action = "ai_use" { RETURN array::len(array::intersect($p.ai_actions, $license.allowed_actions)) > 0; };
 RETURN $action IN $p.content_actions AND $action IN $license.allowed_actions;
};

ALTER TABLE content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_active() FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD public_id ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD item ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD revision ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD version_label ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_url ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_record_key ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD fetched_at ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD published_at ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD updated_at_source ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD published_on ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD updated_on ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_date_text ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD title ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD body_text ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "read") FOR create FULL FOR update FULL;
ALTER FIELD body_sha256 ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_form ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD evidence ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD evidence.* ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD field_issues ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD field_issues.* ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD processing ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD content_kind_payload ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD received_at ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD created_by_subject ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD created_at ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;

ALTER TABLE legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_active() FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD regulation_version ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD local_key ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD label ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD hierarchy_path ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD body_text ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "read") FOR create FULL FOR update FULL;
ALTER FIELD locator ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_locator ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD effective_on ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD created_at ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;

ALTER TABLE content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_active() FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD document_version ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD local_citation_key ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD relation_kind ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD speaker ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD quoted_text ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "cite") FOR create FULL FOR update FULL;
ALTER FIELD locator ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD raw_law_name ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD raw_article_label ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD resolution ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD candidates ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD candidates.* ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD treatment ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD treatment_evidence ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD created_at ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
