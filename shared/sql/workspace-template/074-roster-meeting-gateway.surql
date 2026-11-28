-- 网关仅限当前 workspace。迁移执行器为既有非会议表保留原权限并排除该身份。
DEFINE TABLE IF NOT EXISTS roster_meeting_gateway SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS verifier ON TABLE roster_meeting_gateway TYPE option<string>
  ASSERT $value = NONE OR string::matches($value, '^[a-f0-9]{64}$');

DEFINE ACCESS IF NOT EXISTS roster_meeting_gateway ON DATABASE TYPE RECORD
  SIGNUP NONE
  SIGNIN {
    LET $verifier = SELECT VALUE verifier FROM ONLY roster_meeting_gateway:origin;
    IF $verifier = NONE OR $verifier != crypto::sha256(<string>$proof) {
      THROW 'roster-meeting:denied';
    };
    RETURN roster_meeting_gateway:origin;
  }
  DURATION FOR TOKEN 10m, FOR SESSION 1h;

DEFINE FUNCTION OVERWRITE fn::current_user() -> option<record<user>> {
  IF $auth != NONE {
    IF record::tb($auth) = 'user' { RETURN $auth; };
    RETURN NONE;
  };
  IF $token != NONE AND $token.sub != NONE {
    RETURN (SELECT VALUE id FROM ONLY user WHERE subject = $token.sub LIMIT 1);
  };
  RETURN NONE;
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::is_roster_meeting_gateway() -> bool {
  RETURN session::ac() = 'roster_meeting_gateway' AND $auth = roster_meeting_gateway:origin;
} PERMISSIONS FULL;

ALTER TABLE roster_meeting PERMISSIONS
  FOR select, update WHERE fn::is_roster_meeting_gateway();
-- 真正的管理员会话建立绑定。网关只能沿已绑定的名册与归档表读写。
ALTER FIELD title ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD scheduled_at ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD ends_at ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD roster_sheet ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD display_field ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD check_field ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD check_label ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD check_mode ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD admission ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD concurrency ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD attendance_sheet ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD vote_sheet ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD vote_weight_key ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD vote_agenda ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER FIELD archived_at ON TABLE roster_meeting PERMISSIONS FOR select, create FULL FOR update NONE;

ALTER TABLE roster_meeting_pass PERMISSIONS
  FOR select, create, update WHERE fn::is_roster_meeting_gateway();
ALTER FIELD expires_at ON TABLE roster_meeting_pass PERMISSIONS FOR select, create FULL FOR update NONE;
ALTER TABLE roster_meeting_audit PERMISSIONS
  FOR create WHERE fn::is_roster_meeting_gateway();
ALTER TABLE roster_meeting_event PERMISSIONS
  FOR select, create WHERE fn::is_roster_meeting_gateway();
ALTER TABLE roster_meeting_poll PERMISSIONS
  FOR select WHERE fn::is_roster_meeting_gateway()
  FOR create WHERE fn::is_roster_meeting_gateway() AND meeting.id != NONE AND weight_key = meeting.vote_weight_key;
ALTER TABLE roster_meeting_ballot PERMISSIONS
  FOR select, create WHERE fn::is_roster_meeting_gateway();
ALTER TABLE roster_meeting_ballot_head PERMISSIONS
  FOR select, create, update WHERE fn::is_roster_meeting_gateway();
ALTER TABLE meeting_evidence_archive PERMISSIONS
  FOR select, create WHERE fn::is_roster_meeting_gateway();

-- 动态实体表保留其原有权限。以下固定操作只接受会议绑定与必要投影。
DEFINE API OVERWRITE '/internal/roster-meeting/sheets'
  FOR post PERMISSIONS WHERE fn::is_roster_meeting_gateway() THEN {
    LET $meeting = SELECT * FROM ONLY <record<roster_meeting>>$request.body.meeting;
    RETURN { status: 200, body: (
      SELECT id, workbook, table_name, column_defs FROM sheet
      WHERE id INSIDE [$meeting.roster_sheet, $meeting.attendance_sheet, $meeting.vote_sheet] AND workbook.id != NONE
    ) };
  } SECURITY DEFINER;

DEFINE API OVERWRITE '/internal/roster-meeting/rows'
  FOR post PERMISSIONS WHERE fn::is_roster_meeting_gateway() THEN {
    LET $meeting = SELECT * FROM ONLY <record<roster_meeting>>$request.body.meeting;
    IF $meeting = NONE { RETURN { status: 404 }; };
    LET $sheet = SELECT table_name FROM ONLY $meeting.roster_sheet WHERE workbook.id != NONE;
    IF $sheet = NONE OR !string::matches($sheet.table_name, '^[a-z][a-z0-9_]{0,62}$') { RETURN { status: 404 }; };
    LET $ids = $request.body.ids;
    IF $ids = NONE {
      RETURN { status: 200, body: (
        SELECT id, $this[$meeting.display_field] AS name FROM type::table($sheet.table_name) ORDER BY id LIMIT 10001
      ) };
    };
    IF !type::is_array($ids) OR array::len($ids) > 500 { RETURN { status: 400 }; };
    FOR $id IN $ids {
      IF !type::is_record($id) OR record::tb($id) != $sheet.table_name { RETURN { status: 400 }; };
    };
    LET $poll_id = $request.body.poll;
    IF $poll_id != NONE AND (!type::is_record($poll_id) OR record::tb($poll_id) != 'roster_meeting_poll') {
      RETURN { status: 400 };
    };
    LET $weight = IF $poll_id != NONE { (SELECT VALUE weight_key FROM ONLY $poll_id WHERE meeting = $meeting.id) };
    RETURN { status: 200, body: (
      SELECT id, $this[$meeting.display_field] AS name,
        IF $poll_id = NONE AND $meeting.check_field != NONE { $this[$meeting.check_field] } AS check_value,
        IF $weight != NONE { $this[$weight] } AS weight
      FROM $ids
    ) };
  } SECURITY DEFINER;

DEFINE API OVERWRITE '/internal/roster-meeting/archive'
  FOR post PERMISSIONS WHERE fn::is_roster_meeting_gateway() THEN {
    LET $body = $request.body;
    LET $meeting = SELECT * FROM ONLY <record<roster_meeting>>$body.meeting;
    IF $meeting = NONE OR $meeting.attendance_sheet = NONE OR $meeting.vote_sheet = NONE
      OR $meeting.attendance_sheet != $body.attendance.id OR $meeting.vote_sheet != $body.vote.id {
      RETURN { status: 409 };
    };
    LET $roster = SELECT workbook, table_name FROM ONLY $meeting.roster_sheet WHERE workbook.id != NONE;
    LET $attendance = SELECT workbook, table_name FROM ONLY $meeting.attendance_sheet;
    LET $vote = SELECT workbook, table_name FROM ONLY $meeting.vote_sheet;
    IF $roster = NONE OR $attendance = NONE OR $vote = NONE
      OR $roster.workbook != $attendance.workbook OR $roster.workbook != $vote.workbook
      OR $roster.table_name IN [$attendance.table_name, $vote.table_name] OR $attendance.table_name = $vote.table_name
      OR !string::matches($attendance.table_name, '^ent_[a-z0-9_]{1,59}$') OR !string::matches($vote.table_name, '^ent_[a-z0-9_]{1,59}$')
      OR $attendance.table_name != $body.attendance.table OR $vote.table_name != $body.vote.table {
      RETURN { status: 409 };
    };
    LET $meeting_id = <string>$meeting.id;
    LET $entries = <array<object>>$body.entries;
    FOR $entry IN $entries {
      LET $id = <record>$entry.id;
      IF record::tb($id) NOT IN [$attendance.table_name, $vote.table_name]
        OR !string::matches(<string>record::id($id), '^meeting_[a-f0-9]{64}$') {
        RETURN { status: 409 };
      };
      LET $current = SELECT id, meeting_id FROM ONLY $id;
      IF $current != NONE AND $current.meeting_id != $meeting_id { RETURN { status: 409 }; };
    };
    IF $body.mode = 'existing' {
      LET $ids = $entries.map(|$entry| $entry.id);
      RETURN { status: 200, body: (SELECT VALUE id FROM $ids WHERE meeting_id = $meeting_id) };
    };
    IF $body.mode != 'write' { RETURN { status: 400 }; };
    FOR $entry IN $entries {
      LET $id = <record>$entry.id;
      LET $row = <object>$entry.values;
      IF record::tb($id) = $attendance.table_name {
        UPSERT $id MERGE {
          meeting_id: $meeting_id, subject_id: $row.subject_id, name: $row.name,
          attended: $row.attended, duration_ms: $row.duration_ms, segments: $row.segments, timeline: $row.timeline
        };
      } ELSE {
        UPSERT $id MERGE {
          meeting_id: $meeting_id, poll_id: $row.poll_id, title: $row.title, version: $row.version,
          option: $row.option, label: $row.label, count: $row.count, weight: $row.weight, ballots: $row.ballots
        };
      };
    };
    UPDATE $meeting.id SET archived_at = time::now(), roster_snapshot = roster_snapshot ?? $body.subjects;
    RETURN { status: 200 };
  } SECURITY DEFINER;
