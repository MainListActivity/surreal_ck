-- Workspace provisioning saga progress and native quota migration state.
-- Scope issuance and deferred legacy cleanup both read these fields.

DEFINE FIELD IF NOT EXISTS provisioning_stage ON TABLE workspace TYPE option<string>
  ASSERT $value = NONE
  OR $value INSIDE [
    "reserved",
    "entitlement_resolved",
    "policy_applied",
    "template_applied",
    "owner_seeded",
    "index_ready",
    "completed",
  ];
DEFINE FIELD IF NOT EXISTS provisioning_error_code ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS provisioning_error ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS quota_migration_state ON TABLE workspace TYPE string
  DEFAULT "not_started"
  ASSERT $value INSIDE [
    "not_started",
    "native_applied",
    "native_verified",
    "cleanup_done",
  ];
DEFINE FIELD OVERWRITE last_migration_version ON TABLE workspace TYPE option<int>
  ASSERT $value = NONE
  OR $value >= 0;
DEFINE FIELD IF NOT EXISTS last_migration_error ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_migration_at ON TABLE workspace TYPE option<datetime>;
