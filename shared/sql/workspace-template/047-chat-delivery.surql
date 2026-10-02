-- D1: only additive structures; plaintext answers and credentials never enter workspace rows.
DEFINE TABLE IF NOT EXISTS chat_delivery SCHEMAFULL
  PERMISSIONS
    FOR select, create, update WHERE owner_user = fn::current_user()
      AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS owner_user ON chat_delivery TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS request_key ON chat_delivery TYPE string;
DEFINE FIELD IF NOT EXISTS request_hash ON chat_delivery TYPE string;
DEFINE FIELD IF NOT EXISTS run_id ON chat_delivery TYPE string;
DEFINE FIELD IF NOT EXISTS nonce ON chat_delivery TYPE string;
DEFINE FIELD IF NOT EXISTS status ON chat_delivery TYPE string ASSERT $value INSIDE ["running", "suspended", "complete", "failed"];
DEFINE FIELD IF NOT EXISTS envelope ON chat_delivery TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON chat_delivery TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS chat_delivery_request ON chat_delivery COLUMNS owner_user, request_key UNIQUE;
DEFINE INDEX IF NOT EXISTS chat_delivery_run ON chat_delivery COLUMNS run_id UNIQUE;
