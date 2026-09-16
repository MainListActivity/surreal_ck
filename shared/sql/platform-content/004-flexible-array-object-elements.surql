-- An array<object> creates an implicit `field.*` child definition.  In a
-- SCHEMAFULL table that child must itself be FLEXIBLE or valid nested payload
-- keys (for example, evidence.sourceLocator) are rejected.
--
-- The DEFINE statements make fresh installations correct; ALTER repairs the
-- non-flexible implicit children created by earlier platform-content schemas.
DEFINE FIELD IF NOT EXISTS evidence.* ON TABLE content_version TYPE object FLEXIBLE;
ALTER FIELD evidence.* ON TABLE content_version FLEXIBLE;

DEFINE FIELD IF NOT EXISTS field_issues.* ON TABLE content_version TYPE object FLEXIBLE;
ALTER FIELD field_issues.* ON TABLE content_version FLEXIBLE;

DEFINE FIELD IF NOT EXISTS candidates.* ON TABLE content_citation TYPE object FLEXIBLE;
ALTER FIELD candidates.* ON TABLE content_citation FLEXIBLE;

DEFINE FIELD IF NOT EXISTS candidates.* ON TABLE citation_resolution TYPE object FLEXIBLE;
ALTER FIELD candidates.* ON TABLE citation_resolution FLEXIBLE;

DEFINE FIELD IF NOT EXISTS issues.* ON TABLE ingestion_entry TYPE object FLEXIBLE;
ALTER FIELD issues.* ON TABLE ingestion_entry FLEXIBLE;

DEFINE FIELD IF NOT EXISTS issues.* ON TABLE validation_revision TYPE object FLEXIBLE;
ALTER FIELD issues.* ON TABLE validation_revision FLEXIBLE;

DEFINE FIELD IF NOT EXISTS issues.* ON TABLE publication_item_result TYPE object FLEXIBLE;
ALTER FIELD issues.* ON TABLE publication_item_result FLEXIBLE;
