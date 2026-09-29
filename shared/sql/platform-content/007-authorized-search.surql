-- The publication projection is the only search surface. Row permissions run
-- before LIMIT/COUNT, so a reader cannot count or page through other tenants'
-- content. Raw searchable_text is searchable but never returned to readers.
ALTER TABLE content_publication_projection PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
    OR (item.publication_status = "published" AND item.current_version = version
      AND fn::content_reader_action(version, "search"))
  FOR create, update WHERE $auth = content_publisher_identity:server
  FOR delete NONE;
ALTER FIELD searchable_text ON content_publication_projection PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
  FOR create FULL FOR update FULL;

-- Safe catalog attributes for a version already passing its content gate.
ALTER TABLE content_item PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
    OR fn::content_reader_action(current_version, "metadata")
  FOR create, update WHERE $auth = content_publisher_identity:server
  FOR delete NONE;
ALTER FIELD publication_revision ON content_item PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
  FOR create FULL FOR update FULL;
ALTER FIELD created_at ON content_item PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
  FOR create FULL FOR update FULL;
ALTER FIELD updated_at ON content_item PERMISSIONS
  FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
  FOR create FULL FOR update FULL;
