-- Isolated platform content publisher. Root maintains the credential only.
DEFINE TABLE IF NOT EXISTS content_publisher_identity SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS active ON TABLE content_publisher_identity TYPE bool;
DEFINE TABLE IF NOT EXISTS content_publisher_credential SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS publisher ON TABLE content_publisher_credential TYPE record<content_publisher_identity>;
DEFINE FIELD IF NOT EXISTS secret_hash ON TABLE content_publisher_credential TYPE string;
DEFINE TABLE IF NOT EXISTS content_migration_state SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS source_database ON TABLE content_migration_state TYPE string;
DEFINE FIELD IF NOT EXISTS verified_at ON TABLE content_migration_state TYPE datetime;
DEFINE FIELD IF NOT EXISTS summary ON TABLE content_migration_state TYPE object FLEXIBLE;

DEFINE ACCESS OVERWRITE content_publisher ON DATABASE TYPE RECORD
  SIGNUP NONE
  SIGNIN {
    LET $identity = SELECT * FROM content_publisher_identity:server WHERE active = true;
    LET $credential = SELECT VALUE secret_hash FROM content_publisher_credential:server;
    IF $identity = [] OR $credential = [] OR !crypto::argon2::compare($credential[0], $pass) {
      THROW "content publisher credential rejected";
    };
    RETURN $identity[0];
  }
  DURATION FOR TOKEN 15m, FOR SESSION 15m;

ALTER TABLE content_source PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE source_license_revision PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE content_item PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE content_source_record PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE content_version PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE legal_article_version PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE content_citation PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE citation_resolution PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE cites_article PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE cites_legislation PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE ingestion_batch PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE ingestion_entry PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE validation_revision PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE publication_request PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE publication_item_result PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE publication_event PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
ALTER TABLE content_publication_projection PERMISSIONS
  FOR select, create, update WHERE $auth = content_publisher_identity:server;
ALTER TABLE platform_content_audit_event PERMISSIONS
  FOR select, create WHERE $auth = content_publisher_identity:server;
