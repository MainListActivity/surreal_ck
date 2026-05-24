DEFINE FIELD OVERWRITE status ON TABLE workflow_run TYPE string
  ASSERT $value INSIDE ["running", "success", "failed", "tripwire", "suspended", "waiting", "pending", "canceled", "cancelled", "bailed", "paused", "done"];
DEFINE FIELD IF NOT EXISTS resource_id ON TABLE workflow_run TYPE option<string>;
DEFINE INDEX IF NOT EXISTS workflow_run_resource ON TABLE workflow_run COLUMNS resource_id, created_at;

DEFINE TABLE IF NOT EXISTS memory_resource SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR create WHERE owner_user = $auth,
    FOR update WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR delete WHERE owner_user = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS owner_user ON TABLE memory_resource TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS resource_id ON TABLE memory_resource TYPE string;
DEFINE FIELD IF NOT EXISTS working_memory ON TABLE memory_resource TYPE option<string>;
DEFINE FIELD OVERWRITE metadata ON TABLE memory_resource TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS created_at ON TABLE memory_resource TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE memory_resource TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS memory_resource_id_unique ON TABLE memory_resource COLUMNS resource_id UNIQUE;
DEFINE INDEX IF NOT EXISTS memory_resource_owner ON TABLE memory_resource COLUMNS owner_user, updated_at;

DEFINE TABLE IF NOT EXISTS memory_thread SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR create WHERE owner_user = $auth,
    FOR update WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR delete WHERE owner_user = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS owner_user ON TABLE memory_thread TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS thread_id ON TABLE memory_thread TYPE string;
DEFINE FIELD IF NOT EXISTS resource_id ON TABLE memory_thread TYPE string;
DEFINE FIELD IF NOT EXISTS title ON TABLE memory_thread TYPE option<string>;
DEFINE FIELD OVERWRITE metadata ON TABLE memory_thread TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD IF NOT EXISTS created_at ON TABLE memory_thread TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE memory_thread TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS memory_thread_id_unique ON TABLE memory_thread COLUMNS thread_id UNIQUE;
DEFINE INDEX IF NOT EXISTS memory_thread_resource ON TABLE memory_thread COLUMNS resource_id, updated_at;

DEFINE TABLE IF NOT EXISTS memory_message SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR create WHERE owner_user = $auth,
    FOR update WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR delete WHERE owner_user = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS owner_user ON TABLE memory_message TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS message_id ON TABLE memory_message TYPE string;
DEFINE FIELD IF NOT EXISTS thread_id ON TABLE memory_message TYPE string;
DEFINE FIELD IF NOT EXISTS resource_id ON TABLE memory_message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS role ON TABLE memory_message TYPE string;
DEFINE FIELD IF NOT EXISTS type ON TABLE memory_message TYPE string;
DEFINE FIELD OVERWRITE content ON TABLE memory_message TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE memory_message TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE memory_message TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS memory_message_id_unique ON TABLE memory_message COLUMNS message_id UNIQUE;
DEFINE INDEX IF NOT EXISTS memory_message_thread ON TABLE memory_message COLUMNS thread_id, created_at;
DEFINE INDEX IF NOT EXISTS memory_message_resource ON TABLE memory_message COLUMNS resource_id, created_at;

DEFINE TABLE IF NOT EXISTS observability_span SCHEMALESS
  PERMISSIONS
    FOR select WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR create WHERE owner_user = $auth,
    FOR update WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR delete WHERE owner_user = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS owner_user ON TABLE observability_span TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS traceId ON TABLE observability_span TYPE string;
DEFINE FIELD IF NOT EXISTS spanId ON TABLE observability_span TYPE string;
DEFINE FIELD IF NOT EXISTS parentSpanId ON TABLE observability_span TYPE option<string>;
DEFINE FIELD IF NOT EXISTS name ON TABLE observability_span TYPE string;
DEFINE FIELD IF NOT EXISTS spanType ON TABLE observability_span TYPE option<string>;
DEFINE FIELD IF NOT EXISTS isEvent ON TABLE observability_span TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS startedAt ON TABLE observability_span TYPE datetime;
DEFINE FIELD IF NOT EXISTS endedAt ON TABLE observability_span TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS createdAt ON TABLE observability_span TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON TABLE observability_span TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE observability_span TYPE datetime;
DEFINE FIELD IF NOT EXISTS user_id ON TABLE observability_span TYPE option<string>;
DEFINE FIELD IF NOT EXISTS resource_id ON TABLE observability_span TYPE option<string>;
DEFINE FIELD IF NOT EXISTS thread_id ON TABLE observability_span TYPE option<string>;
DEFINE FIELD IF NOT EXISTS agent_id ON TABLE observability_span TYPE option<string>;
DEFINE FIELD IF NOT EXISTS workflow_id ON TABLE observability_span TYPE option<string>;
DEFINE INDEX IF NOT EXISTS observability_span_unique ON TABLE observability_span COLUMNS traceId, spanId UNIQUE;
DEFINE INDEX IF NOT EXISTS observability_span_trace ON TABLE observability_span COLUMNS traceId, startedAt;
DEFINE INDEX IF NOT EXISTS observability_span_expiry ON TABLE observability_span COLUMNS expires_at;
DEFINE EVENT OVERWRITE observability_span_cleanup ON TABLE observability_span
  WHEN $event = "CREATE" OR $event = "UPDATE"
  THEN {
    DELETE observability_span WHERE expires_at < time::now();
  };

DEFINE TABLE IF NOT EXISTS observability_event_raw SCHEMALESS
  PERMISSIONS
    FOR select WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR create WHERE owner_user = $auth,
    FOR update WHERE owner_user = $auth OR $auth.is_admin = true,
    FOR delete WHERE owner_user = $auth OR $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS owner_user ON TABLE observability_event_raw TYPE record<user> DEFAULT $auth;
DEFINE FIELD IF NOT EXISTS kind ON TABLE observability_event_raw TYPE string;
DEFINE FIELD IF NOT EXISTS payload ON TABLE observability_event_raw TYPE any;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE observability_event_raw TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE observability_event_raw TYPE datetime;
DEFINE INDEX IF NOT EXISTS observability_event_raw_expiry ON TABLE observability_event_raw COLUMNS expires_at;
DEFINE EVENT OVERWRITE observability_event_raw_cleanup ON TABLE observability_event_raw
  WHEN $event = "CREATE" OR $event = "UPDATE"
  THEN {
    DELETE observability_event_raw WHERE expires_at < time::now();
  };
