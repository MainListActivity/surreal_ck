-- The projection sync identity may enumerate current publications to prepare
-- short reader leases. Customers cannot read this operational projection.
ALTER TABLE content_publication_projection PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
  FOR create, update WHERE $auth = content_publisher_identity:server
  FOR delete NONE;

-- Safe facets are copied into a distinct table. This migration only adds rows;
-- it does not alter previously published versions or projections.
DEFINE TABLE content_search_facet SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
      OR (item.publication_status = "published" AND item.current_version = version
        AND fn::content_reader_action(version, "search"))
    FOR create, update WHERE $auth = content_publisher_identity:server
    FOR delete NONE;
DEFINE FIELD item ON content_search_facet TYPE record<content_item>;
DEFINE FIELD version ON content_search_facet TYPE record<content_version>;
DEFINE FIELD kind ON content_search_facet TYPE string;
DEFINE FIELD jurisdiction ON content_search_facet TYPE option<string>;
DEFINE FIELD published_on ON content_search_facet TYPE option<string>;
DEFINE FIELD effective_on ON content_search_facet TYPE option<string>;
DEFINE INDEX content_search_facet_item ON content_search_facet FIELDS item UNIQUE;
