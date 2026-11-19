DEFINE FUNCTION OVERWRITE fn::meeting_human($who: record<user>) {
  RETURN array::len(SELECT VALUE id FROM user WHERE id = $who AND kind = 'human' AND disabled_at = NONE) = 1;
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_present($room: record<meeting>, $who: record<user>) {
  RETURN $room.status = 'active' AND fn::meeting_human($who)
    AND array::len(SELECT VALUE id FROM meeting_participant WHERE meeting = $room AND user = $who AND left_at = NONE LIMIT 1) = 1;
} PERMISSIONS FULL;

DEFINE TABLE OVERWRITE meeting_presence_lock SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE revision ON meeting_presence_lock TYPE int;

DEFINE TABLE OVERWRITE meeting SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE AND fn::meeting_human($auth.id) AND (status = 'active' OR host = $auth.id)
    FOR create WHERE $auth != NONE AND host = $auth.id AND fn::meeting_human($auth.id)
    FOR update WHERE $auth != NONE AND host = $auth.id AND fn::meeting_human($auth.id)
    FOR delete NONE;
DEFINE FIELD OVERWRITE code ON meeting TYPE string
  VALUE IF $before = NONE { string::slice(string::replace(<string>rand::uuid::v4(), '-', ''), 0, 12) } ELSE { $before };
DEFINE FIELD OVERWRITE title ON meeting TYPE string ASSERT string::len(string::trim($value)) > 0 AND string::len($value) <= 200;
DEFINE FIELD OVERWRITE host ON meeting TYPE record<user> DEFAULT $auth.id;
DEFINE FIELD OVERWRITE status ON meeting TYPE 'active' | 'ended' DEFAULT 'active';
DEFINE FIELD OVERWRITE conversation ON meeting TYPE option<record<chat_conversation>>;
DEFINE FIELD OVERWRITE created_at ON meeting TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD OVERWRITE ended_at ON meeting TYPE option<datetime>
  VALUE IF $this.status = 'ended' { IF $before = NONE { time::now() } ELSE { $before } } ELSE { NONE };
DEFINE INDEX OVERWRITE meeting_code ON meeting FIELDS code UNIQUE;
DEFINE INDEX OVERWRITE meeting_status ON meeting FIELDS status, created_at;

DEFINE TABLE OVERWRITE meeting_participant SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE AND fn::meeting_human($auth.id) AND (user = $auth.id OR fn::meeting_present(meeting, $auth.id))
    FOR create WHERE $auth != NONE AND user = $auth.id AND fn::meeting_human($auth.id) AND meeting.status = 'active'
    FOR update WHERE $auth != NONE AND fn::meeting_human($auth.id) AND (user = $auth.id OR meeting.host = $auth.id)
    FOR delete NONE;
DEFINE FIELD OVERWRITE meeting ON meeting_participant TYPE record<meeting>;
DEFINE FIELD OVERWRITE user ON meeting_participant TYPE record<user> DEFAULT $auth.id;
DEFINE FIELD OVERWRITE role ON meeting_participant TYPE 'host' | 'member'
  VALUE IF $this.meeting.host = $this.user { 'host' } ELSE { 'member' };
DEFINE FIELD OVERWRITE joined_at ON meeting_participant TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD OVERWRITE left_at ON meeting_participant TYPE option<datetime>
  VALUE IF $value = NONE { NONE } ELSE { IF $before = NONE { time::now() } ELSE { $before } };
DEFINE FIELD OVERWRITE last_seen ON meeting_participant TYPE datetime
  VALUE IF $auth.id = $this.user { time::now() } ELSE { $before };
DEFINE FIELD OVERWRITE mic ON meeting_participant TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE cam ON meeting_participant TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE screen ON meeting_participant TYPE bool DEFAULT false;
DEFINE INDEX OVERWRITE meeting_membership ON meeting_participant FIELDS meeting, user UNIQUE;
DEFINE INDEX OVERWRITE meeting_presence ON meeting_participant FIELDS meeting, left_at;

DEFINE EVENT OVERWRITE meeting_participant_guard ON meeting_participant WHEN $event IN ['CREATE', 'UPDATE'] THEN {
  IF $auth = NONE OR !fn::meeting_human($auth.id) { THROW 'meeting: active human required'; };
  IF $event = 'CREATE' {
    IF $after.user != $auth.id OR $after.left_at != NONE { THROW 'meeting: join as self only'; };
  } ELSE {
    IF $before.meeting != $after.meeting OR $before.user != $after.user OR $before.role != $after.role OR $before.joined_at != $after.joined_at {
      THROW 'meeting: immutable participant';
    };
    IF $after.user != $auth.id {
      IF $after.meeting.host != $auth.id OR $before.left_at != NONE OR $after.left_at = NONE
        OR $before.mic != $after.mic OR $before.cam != $after.cam OR $before.screen != $after.screen OR $before.last_seen != $after.last_seen {
        THROW 'meeting: host may only remove a participant';
      };
    };
  };
  LET $lock = type::record('meeting_presence_lock', <string>$after.meeting);
  UPDATE $lock SET revision += 1;
  IF $after.left_at = NONE {
    IF $after.meeting.status != 'active' OR !fn::meeting_human($after.user) { THROW 'meeting: not active'; };
    IF array::len(SELECT VALUE id FROM meeting_participant WHERE meeting = $after.meeting AND left_at = NONE) > 6 {
      THROW 'meeting: capacity is six';
    };
  };
};

DEFINE EVENT OVERWRITE meeting_guard ON meeting WHEN $event IN ['CREATE', 'UPDATE'] THEN {
  IF $auth = NONE OR $after.host != $auth.id OR !fn::meeting_human($auth.id) { THROW 'meeting: host required'; };
  IF $event = 'CREATE' {
    IF $after.status != 'active' OR $after.ended_at != NONE { THROW 'meeting: create active only'; };
    IF $after.conversation != NONE AND !fn::chat_joined($after.conversation, $auth.id) { THROW 'meeting: conversation membership required'; };
    CREATE type::record('meeting_presence_lock', <string>$after.id) SET revision = 0;
    CREATE meeting_participant CONTENT { meeting: $after.id, user: $auth.id };
  } ELSE {
    IF $before.status != 'active' OR $after.status != 'ended'
      OR $before.host != $after.host OR $before.title != $after.title OR $before.code != $after.code
      OR $before.conversation != $after.conversation OR $before.created_at != $after.created_at {
      THROW 'meeting: only ending is allowed';
    };
    UPDATE type::record('meeting_presence_lock', <string>$after.id) SET revision += 1;
    UPDATE meeting_participant SET left_at = time::now() WHERE meeting = $after.id AND left_at = NONE;
  };
};

DEFINE FUNCTION OVERWRITE fn::meeting_join($code: string) {
  IF $auth = NONE OR !fn::meeting_human($auth.id) { THROW 'meeting: active human required'; };
  LET $rooms = SELECT * FROM meeting WHERE code = string::lowercase(string::trim($code)) AND status = 'active' LIMIT 1;
  IF array::len($rooms) != 1 { THROW 'meeting: active code not found'; };
  LET $room = $rooms[0].id;
  INSERT INTO meeting_participant { meeting: $room, user: $auth.id } ON DUPLICATE KEY UPDATE user = $auth.id;
  RETURN UPDATE meeting_participant SET left_at = NONE WHERE meeting = $room AND user = $auth.id;
} PERMISSIONS FULL;

DEFINE TABLE OVERWRITE meeting_signal_rate SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE sender ON meeting_signal_rate TYPE record<user>;
DEFINE FIELD OVERWRITE window_start ON meeting_signal_rate TYPE datetime;
DEFINE FIELD OVERWRITE count ON meeting_signal_rate TYPE int;
DEFINE INDEX OVERWRITE meeting_signal_rate_sender ON meeting_signal_rate FIELDS sender UNIQUE;

DEFINE TABLE OVERWRITE meeting_signal SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE AND ($auth.id = `from` OR $auth.id = to)
      AND fn::meeting_present(meeting, `from`) AND fn::meeting_present(meeting, to) AND expires_at > time::now()
    FOR create WHERE $auth != NONE AND $auth.id = `from` AND fn::meeting_present(meeting, `from`) AND fn::meeting_present(meeting, to)
    FOR update, delete NONE;
DEFINE FIELD OVERWRITE meeting ON meeting_signal TYPE record<meeting>;
DEFINE FIELD OVERWRITE `from` ON meeting_signal TYPE record<user> DEFAULT $auth.id;
DEFINE FIELD OVERWRITE to ON meeting_signal TYPE record<user>;
DEFINE FIELD OVERWRITE kind ON meeting_signal TYPE 'offer' | 'answer' | 'ice' | 'bye';
DEFINE FIELD OVERWRITE payload ON meeting_signal TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 49152;
DEFINE FIELD OVERWRITE session ON meeting_signal TYPE string ASSERT string::matches($value, '^[0-9a-f]{64}$');
DEFINE FIELD OVERWRITE nonce ON meeting_signal TYPE string ASSERT string::matches($value, '^[0-9a-f]{64}$');
DEFINE FIELD OVERWRITE handshake_key ON meeting_signal TYPE option<string>
  VALUE IF $this.kind IN ['offer', 'answer'] {
    crypto::sha256(encoding::json::encode([$this.meeting, $this.from, $this.to, $this.kind, $this.session]))
  } ELSE { NONE };
DEFINE FIELD OVERWRITE created_at ON meeting_signal TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD OVERWRITE expires_at ON meeting_signal TYPE datetime VALUE time::now() + 120s READONLY;
DEFINE INDEX OVERWRITE meeting_signal_nonce ON meeting_signal FIELDS `from`, nonce UNIQUE;
DEFINE INDEX OVERWRITE meeting_signal_session ON meeting_signal FIELDS meeting, `from`, to, session, nonce UNIQUE;
DEFINE INDEX OVERWRITE meeting_signal_handshake ON meeting_signal FIELDS handshake_key UNIQUE;
DEFINE INDEX OVERWRITE meeting_signal_inbox ON meeting_signal FIELDS to, expires_at;

DEFINE EVENT OVERWRITE meeting_signal_guard ON meeting_signal WHEN $event = 'CREATE' THEN {
  IF $auth = NONE OR $auth.id != $after.from OR $after.from = $after.to
    OR !fn::meeting_present($after.meeting, $after.from) OR !fn::meeting_present($after.meeting, $after.to) {
    THROW 'meeting: current sender and recipient required';
  };
  UPDATE type::record('meeting_presence_lock', <string>$after.meeting) SET revision += 1;
  LET $rate = type::record('meeting_signal_rate', <string>$after.from);
  LET $last = SELECT * FROM ONLY $rate;
  LET $continuing = $last != NONE AND $last.window_start + 10s > time::now();
  IF $continuing AND $last.count >= 120 { THROW 'meeting: signal rate limit'; };
  UPSERT $rate SET sender = $after.from,
    window_start = IF $continuing { $last.window_start } ELSE { time::now() },
    count = IF $continuing { $last.count + 1 } ELSE { 1 };
};
