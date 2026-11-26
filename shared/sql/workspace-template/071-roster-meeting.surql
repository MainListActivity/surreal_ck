DEFINE TABLE IF NOT EXISTS roster_meeting SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS title ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS scheduled_at ON TABLE roster_meeting TYPE datetime;
DEFINE FIELD IF NOT EXISTS ends_at ON TABLE roster_meeting TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS roster_sheet ON TABLE roster_meeting TYPE record<sheet>;
DEFINE FIELD IF NOT EXISTS display_field ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS check_field ON TABLE roster_meeting TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_label ON TABLE roster_meeting TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_mode ON TABLE roster_meeting TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["full", "suffix4"];
DEFINE FIELD IF NOT EXISTS admission ON TABLE roster_meeting TYPE string
  ASSERT $value INSIDE ["direct", "waiting"];
DEFINE FIELD IF NOT EXISTS concurrency ON TABLE roster_meeting TYPE string DEFAULT "replace"
  ASSERT $value INSIDE ["replace", "reject"];
DEFINE FIELD IF NOT EXISTS status ON TABLE roster_meeting TYPE string DEFAULT "open"
  ASSERT $value INSIDE ["open", "closed"];
DEFINE FIELD IF NOT EXISTS room_id ON TABLE roster_meeting TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE roster_meeting TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE roster_meeting TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE roster_meeting TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS roster_meeting_pass SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS meeting ON TABLE roster_meeting_pass TYPE record<roster_meeting> READONLY;
DEFINE FIELD IF NOT EXISTS roster_row ON TABLE roster_meeting_pass TYPE record READONLY;
DEFINE FIELD IF NOT EXISTS pass_hash ON TABLE roster_meeting_pass TYPE string READONLY
  ASSERT string::len($value) INSIDE 1..=128;
DEFINE FIELD IF NOT EXISTS code_hash ON TABLE roster_meeting_pass TYPE string READONLY
  ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS status ON TABLE roster_meeting_pass TYPE string DEFAULT "active"
  ASSERT $value INSIDE ["active", "revoked"];
DEFINE FIELD IF NOT EXISTS active_key ON TABLE roster_meeting_pass TYPE string
  VALUE IF $this.status = "active" {
    <string>type::record("active", [$this.meeting, $this.roster_row])
  } ELSE { <string>$this.id };
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE roster_meeting_pass TYPE datetime;
DEFINE FIELD IF NOT EXISTS opened_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS failure_count ON TABLE roster_meeting_pass TYPE int DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS last_attempt_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS failure_window_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS locked_until ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_generation ON TABLE roster_meeting_pass TYPE int DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS lease_session ON TABLE roster_meeting_pass TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_verified_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_state ON TABLE roster_meeting_pass TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["waiting", "admitted", "kicked"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE roster_meeting_pass TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE roster_meeting_pass TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS roster_meeting_pass_hash_unique ON TABLE roster_meeting_pass COLUMNS pass_hash UNIQUE;
DEFINE INDEX IF NOT EXISTS roster_meeting_pass_one_active ON TABLE roster_meeting_pass COLUMNS active_key UNIQUE;
DEFINE INDEX IF NOT EXISTS roster_meeting_pass_meeting_row ON TABLE roster_meeting_pass COLUMNS meeting, roster_row;

DEFINE TABLE IF NOT EXISTS roster_meeting_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS action ON TABLE roster_meeting_audit TYPE string READONLY
  ASSERT $value INSIDE ["issued", "revoked", "verify_ok", "verify_failed", "replaced", "kicked", "rejected_concurrent"];
DEFINE FIELD IF NOT EXISTS actor ON TABLE roster_meeting_audit TYPE string READONLY
  ASSERT string::len($value) INSIDE 1..=256;
DEFINE FIELD IF NOT EXISTS target ON TABLE roster_meeting_audit TYPE record READONLY;
DEFINE FIELD IF NOT EXISTS at ON TABLE roster_meeting_audit TYPE datetime VALUE time::now() READONLY;
DEFINE EVENT IF NOT EXISTS roster_meeting_audit_immutable ON TABLE roster_meeting_audit
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "roster meeting audit: append only"; };

DEFINE FIELD IF NOT EXISTS roster_meeting_presets ON TABLE workbook_template TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.key ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.label ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.sheet_key ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.display_key ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.check_key ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.check_label ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.check_mode ON TABLE workbook_template TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["full", "suffix4"];
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.admission ON TABLE workbook_template TYPE string
  ASSERT $value INSIDE ["direct", "waiting"];
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.concurrency ON TABLE workbook_template TYPE string
  ASSERT $value INSIDE ["replace", "reject"];
