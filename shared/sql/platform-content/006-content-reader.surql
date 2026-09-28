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
 PERMISSIONS FOR select WHERE $auth = content_projection_identity:server OR id = $auth FOR create, update WHERE $auth = content_projection_identity:server FOR delete NONE;
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
DEFINE FIELD confirmed_until ON content_authorization_projection TYPE datetime;
DEFINE FIELD status ON content_authorization_projection TYPE string ASSERT $value IN ["active", "closed"];
DEFINE INDEX content_projection_workspace ON content_authorization_projection FIELDS workspace_id UNIQUE;

-- One opened version. The sync identity writes it; readers never do.
DEFINE TABLE content_read_gate SCHEMAFULL
 PERMISSIONS
  FOR select WHERE $access = "content_reader"
   AND workspace_id = $token.workspace_id
   AND revision = $token.entitlement_revision
   AND $token.sub IN allowed_subjects
   AND status = "active"
  FOR create, update WHERE $auth = content_projection_identity:server
  FOR delete NONE;
DEFINE FIELD version ON content_read_gate TYPE record<content_version>;
DEFINE FIELD item ON content_read_gate TYPE record<content_item>;
DEFINE FIELD license ON content_read_gate TYPE record<source_license_revision>;
DEFINE FIELD workspace_id ON content_read_gate TYPE string;
DEFINE FIELD revision ON content_read_gate TYPE string;
DEFINE FIELD actions ON content_read_gate TYPE array<string> ASSERT array::all($value, |$v| $v IN ["browse", "search", "read", "cite", "export"]);
DEFINE FIELD ai_actions ON content_read_gate TYPE array<string> ASSERT array::all($value, |$v| $v IN ["research", "generate"]);
DEFINE FIELD source_status ON content_read_gate TYPE string ASSERT $value IN ["active", "inactive"];
DEFINE FIELD publication_status ON content_read_gate TYPE string;
DEFINE FIELD license_from ON content_read_gate TYPE datetime;
DEFINE FIELD license_until ON content_read_gate TYPE option<datetime>;
DEFINE FIELD license_actions ON content_read_gate TYPE array<string>;
DEFINE FIELD collection_matched ON content_read_gate TYPE bool;
DEFINE FIELD allowed_subjects ON content_read_gate TYPE array<string>;
DEFINE FIELD status ON content_read_gate TYPE string ASSERT $value IN ["active", "closed"];
DEFINE INDEX content_read_gate_version ON content_read_gate FIELDS workspace_id, version UNIQUE;

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

DEFINE FUNCTION fn::content_reader_visible($version: record<content_version>) {
 IF !fn::content_reader_active() { RETURN false; };
 LET $p = SELECT * FROM ONLY $auth;
 LET $g = (SELECT * FROM content_read_gate WHERE version = $version AND workspace_id = $p.workspace_id AND revision = $p.revision AND status = "active" LIMIT 1)[0];
 IF $g = NONE OR $g.collection_matched != true OR $g.source_status != "active" OR $g.publication_status != "published"
  OR $g.license_from > time::now() OR ($g.license_until != NONE AND $g.license_until <= time::now()) { RETURN false; };
 RETURN array::len(array::intersect($g.actions, $g.license_actions)) > 0 OR array::len(array::intersect($g.ai_actions, $g.license_actions)) > 0;
};

DEFINE FUNCTION fn::content_reader_action($version: record<content_version>, $action: string) {
 IF !fn::content_reader_active() { RETURN false; };
 LET $p = SELECT * FROM ONLY $auth;
 LET $g = (SELECT * FROM content_read_gate WHERE version = $version AND workspace_id = $p.workspace_id AND revision = $p.revision AND status = "active" LIMIT 1)[0];
 IF $g = NONE OR $g.collection_matched != true OR $g.source_status != "active" OR $g.publication_status != "published"
  OR $g.license_from > time::now() OR ($g.license_until != NONE AND $g.license_until <= time::now()) { RETURN false; };
 IF $action = "metadata" { RETURN ("browse" IN $g.actions AND "browse" IN $g.license_actions) OR ("search" IN $g.actions AND "search" IN $g.license_actions); };
 IF $action = "ai_use" { RETURN ("research" IN $g.ai_actions AND "research" IN $g.license_actions) OR ("generate" IN $g.ai_actions AND "generate" IN $g.license_actions); };
 RETURN $action IN $g.actions AND $action IN $g.license_actions;
};

ALTER TABLE content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_visible(id) FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD public_id ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD item ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD revision ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD version_label ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_url ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_record_key ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD fetched_at ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD published_at ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD updated_at_source ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD published_on ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD updated_on ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_date_text ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD title ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD body_text ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(id, "read") FOR create FULL FOR update FULL;
ALTER FIELD body_sha256 ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_form ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD evidence ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD evidence.* ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD field_issues ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD field_issues.* ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD processing ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD content_kind_payload ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD received_at ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD created_by_subject ON content_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD created_at ON content_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(id, "metadata") FOR create FULL FOR update FULL;

ALTER TABLE legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_visible(regulation_version) FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD regulation_version ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD local_key ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD label ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD hierarchy_path ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD body_text ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(regulation_version, "read") FOR create FULL FOR update FULL;
ALTER FIELD locator ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD source_locator ON legal_article_version PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD effective_on ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD created_at ON legal_article_version PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(regulation_version, "metadata") FOR create FULL FOR update FULL;

ALTER TABLE content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_visible(document_version) FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD document_version ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD local_citation_key ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD relation_kind ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD speaker ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD quoted_text ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_action(document_version, "cite") FOR create FULL FOR update FULL;
ALTER FIELD locator ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD raw_law_name ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD raw_article_label ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD resolution ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD candidates ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD candidates.* ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD treatment ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;
ALTER FIELD treatment_evidence ON content_citation PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER FIELD created_at ON content_citation PERMISSIONS FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server] OR fn::content_reader_action(document_version, "metadata") FOR create FULL FOR update FULL;

ALTER TABLE content_source PERMISSIONS
 FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
 FOR create, update WHERE $auth = content_publisher_identity:server FOR delete NONE;
ALTER TABLE source_license_revision PERMISSIONS
 FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
 FOR create WHERE $auth = content_publisher_identity:server FOR update, delete NONE;
ALTER FIELD evidence_text ON source_license_revision PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server FOR create FULL FOR update FULL;
ALTER TABLE content_item PERMISSIONS
 FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
 FOR create, update WHERE $auth = content_publisher_identity:server FOR delete NONE;
