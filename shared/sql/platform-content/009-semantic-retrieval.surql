-- Additive index only: immutable content versions and existing publications are untouched.
-- No profile is seeded: operators must approve a model/release and its source licenses.
DEFINE TABLE content_embedding_profile SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth = content_publisher_identity:server OR fn::content_reader_active()
  FOR create, update WHERE $auth = content_publisher_identity:server FOR delete NONE;
DEFINE FIELD provider ON content_embedding_profile TYPE string;
DEFINE FIELD model ON content_embedding_profile TYPE string;
DEFINE FIELD dimensions ON content_embedding_profile TYPE int ASSERT $value = 1536;
DEFINE FIELD version ON content_embedding_profile TYPE string;
DEFINE FIELD release ON content_embedding_profile TYPE string;
DEFINE FIELD base_url ON content_embedding_profile TYPE option<string>;
DEFINE FIELD api_format ON content_embedding_profile TYPE option<string>;

DEFINE TABLE content_search_embedding SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth = content_publisher_identity:server
      OR (item.publication_status = "published" AND item.current_version = version
        AND fn::content_reader_action(version, "search"))
    FOR create, update WHERE $auth = content_publisher_identity:server FOR delete NONE;
DEFINE FIELD item ON content_search_embedding TYPE record<content_item>;
DEFINE FIELD version ON content_search_embedding TYPE record<content_version>;
DEFINE FIELD profile_key ON content_search_embedding TYPE string;
DEFINE FIELD release ON content_search_embedding TYPE string;
DEFINE FIELD body_sha256 ON content_search_embedding TYPE string;
DEFINE FIELD vector ON content_search_embedding TYPE array<float> ASSERT array::len($value) = 1536;
DEFINE FIELD indexed_at ON content_search_embedding TYPE datetime DEFAULT time::now();
DEFINE INDEX content_embedding_identity ON content_search_embedding FIELDS version, profile_key, release UNIQUE;
DEFINE INDEX content_embedding_hnsw ON content_search_embedding FIELDS vector HNSW DIMENSION 1536 DIST COSINE TYPE F32 EFC 150 M 12;

-- Only safe, source-derived signals are exposed; unknown facts remain neutral.
DEFINE FIELD procedure ON content_search_facet TYPE option<string>;
DEFINE FIELD issue ON content_search_facet TYPE option<string>;
DEFINE FIELD authority ON content_search_facet TYPE option<float> ASSERT $value = NONE OR ($value >= 0 AND $value <= 1);
DEFINE FIELD quality ON content_search_facet TYPE option<float> ASSERT $value = NONE OR ($value >= 0 AND $value <= 1);
