DEFINE FIELD IF NOT EXISTS roster_snapshot ON TABLE roster_meeting TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS roster_snapshot.* ON TABLE roster_meeting TYPE object;
DEFINE FIELD IF NOT EXISTS roster_snapshot.*.subject ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS roster_snapshot.*.name ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS ended_at ON TABLE roster_meeting TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS attendance_sheet ON TABLE roster_meeting TYPE option<record<sheet>>;
DEFINE FIELD IF NOT EXISTS vote_sheet ON TABLE roster_meeting TYPE option<record<sheet>>;
DEFINE FIELD IF NOT EXISTS vote_weight_key ON TABLE roster_meeting TYPE option<string>;
DEFINE FIELD IF NOT EXISTS vote_agenda ON TABLE roster_meeting TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS vote_agenda.* ON TABLE roster_meeting TYPE object;
DEFINE FIELD IF NOT EXISTS vote_agenda.*.title ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS vote_agenda.*.allowChange ON TABLE roster_meeting TYPE bool;
DEFINE FIELD IF NOT EXISTS vote_agenda.*.options ON TABLE roster_meeting TYPE array<object>;
DEFINE FIELD IF NOT EXISTS vote_agenda.*.options.* ON TABLE roster_meeting TYPE object;
DEFINE FIELD IF NOT EXISTS vote_agenda.*.options.*.key ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS vote_agenda.*.options.*.label ON TABLE roster_meeting TYPE string;
DEFINE FIELD IF NOT EXISTS archived_at ON TABLE roster_meeting TYPE option<datetime>;

DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_weight_key ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda ON TABLE workbook_template TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.* ON TABLE workbook_template TYPE object;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.*.title ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.*.allowChange ON TABLE workbook_template TYPE bool;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.*.options ON TABLE workbook_template TYPE array<object>;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.*.options.* ON TABLE workbook_template TYPE object;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.*.options.*.key ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS roster_meeting_presets.*.vote_agenda.*.options.*.label ON TABLE workbook_template TYPE string;

DEFINE TABLE IF NOT EXISTS roster_meeting_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS meeting ON TABLE roster_meeting_event TYPE record<roster_meeting> READONLY;
DEFINE FIELD IF NOT EXISTS subject ON TABLE roster_meeting_event TYPE record READONLY;
DEFINE FIELD IF NOT EXISTS pass ON TABLE roster_meeting_event TYPE record<roster_meeting_pass> READONLY;
DEFINE FIELD IF NOT EXISTS kind ON TABLE roster_meeting_event TYPE string READONLY
  ASSERT $value INSIDE ["verified", "admitted", "replaced", "kicked", "rejected", "revoked", "joined", "left", "raised", "allowed", "withdrawn"];
DEFINE FIELD IF NOT EXISTS at ON TABLE roster_meeting_event TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS connection ON TABLE roster_meeting_event TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS actor ON TABLE roster_meeting_event TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS name ON TABLE roster_meeting_event TYPE option<string> READONLY;
DEFINE INDEX IF NOT EXISTS roster_meeting_event_timeline ON TABLE roster_meeting_event COLUMNS meeting, at;
DEFINE EVENT IF NOT EXISTS roster_meeting_event_immutable ON TABLE roster_meeting_event
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "roster meeting event: append only"; };

DEFINE TABLE IF NOT EXISTS roster_meeting_poll SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS meeting ON TABLE roster_meeting_poll TYPE record<roster_meeting> READONLY;
DEFINE FIELD IF NOT EXISTS title ON TABLE roster_meeting_poll TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS version ON TABLE roster_meeting_poll TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS deadline ON TABLE roster_meeting_poll TYPE datetime READONLY;
DEFINE FIELD IF NOT EXISTS options ON TABLE roster_meeting_poll TYPE array<object> READONLY;
DEFINE FIELD IF NOT EXISTS options.* ON TABLE roster_meeting_poll TYPE object;
DEFINE FIELD IF NOT EXISTS options.*.key ON TABLE roster_meeting_poll TYPE string;
DEFINE FIELD IF NOT EXISTS options.*.label ON TABLE roster_meeting_poll TYPE string;
DEFINE FIELD IF NOT EXISTS allow_change ON TABLE roster_meeting_poll TYPE bool READONLY;
DEFINE FIELD IF NOT EXISTS weight_key ON TABLE roster_meeting_poll TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE roster_meeting_poll TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS roster_meeting_poll_meeting ON TABLE roster_meeting_poll COLUMNS meeting;

DEFINE TABLE IF NOT EXISTS roster_meeting_ballot SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS meeting ON TABLE roster_meeting_ballot TYPE record<roster_meeting> READONLY;
DEFINE FIELD IF NOT EXISTS poll ON TABLE roster_meeting_ballot TYPE record<roster_meeting_poll> READONLY;
DEFINE FIELD IF NOT EXISTS subject ON TABLE roster_meeting_ballot TYPE record READONLY;
DEFINE FIELD IF NOT EXISTS name ON TABLE roster_meeting_ballot TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS choice ON TABLE roster_meeting_ballot TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS note ON TABLE roster_meeting_ballot TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS weight ON TABLE roster_meeting_ballot TYPE decimal READONLY;
DEFINE FIELD IF NOT EXISTS revision ON TABLE roster_meeting_ballot TYPE int READONLY;
DEFINE FIELD IF NOT EXISTS at ON TABLE roster_meeting_ballot TYPE datetime READONLY;
DEFINE INDEX IF NOT EXISTS roster_meeting_ballot_meeting ON TABLE roster_meeting_ballot COLUMNS meeting;
DEFINE EVENT IF NOT EXISTS roster_meeting_ballot_immutable ON TABLE roster_meeting_ballot
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "roster meeting ballot: append only"; };

DEFINE TABLE IF NOT EXISTS roster_meeting_ballot_head SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS meeting ON TABLE roster_meeting_ballot_head TYPE record<roster_meeting>;
DEFINE FIELD IF NOT EXISTS poll ON TABLE roster_meeting_ballot_head TYPE record<roster_meeting_poll>;
DEFINE FIELD IF NOT EXISTS ballot ON TABLE roster_meeting_ballot_head TYPE record<roster_meeting_ballot>;
DEFINE INDEX IF NOT EXISTS roster_meeting_ballot_head_meeting ON TABLE roster_meeting_ballot_head COLUMNS meeting;
