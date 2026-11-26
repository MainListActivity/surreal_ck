DEFINE FIELD IF NOT EXISTS room_id ON TABLE roster_meeting TYPE option<string>;
DEFINE FIELD IF NOT EXISTS opened_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS failure_window_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_verified_at ON TABLE roster_meeting_pass TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lease_state ON TABLE roster_meeting_pass TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["waiting", "admitted", "kicked"];
