-- 会议控制面；062 双人信令不变。Owner/root 为可信维护方。
DEFINE TABLE OVERWRITE native_meeting_room SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE code ON native_meeting_room TYPE string;
DEFINE FIELD OVERWRITE host ON native_meeting_room TYPE record<user>;
DEFINE FIELD OVERWRITE status ON native_meeting_room TYPE 'open' | 'ended';
DEFINE FIELD OVERWRITE version ON native_meeting_room TYPE int;
DEFINE FIELD OVERWRITE signal_revision ON native_meeting_room TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE invite_count ON native_meeting_room TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_room TYPE datetime;
DEFINE FIELD OVERWRITE next_check_at ON native_meeting_room TYPE option<datetime>;
DEFINE FIELD OVERWRITE purge_at ON native_meeting_room TYPE datetime;
DEFINE FIELD OVERWRITE members ON native_meeting_room TYPE array<object>;
DEFINE FIELD OVERWRITE members.* ON native_meeting_room TYPE object FLEXIBLE;
DEFINE INDEX OVERWRITE native_meeting_room_check ON native_meeting_room FIELDS next_check_at;
DEFINE INDEX OVERWRITE native_meeting_room_purge ON native_meeting_room FIELDS purge_at;

DEFINE TABLE OVERWRITE native_meeting_code SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE room ON native_meeting_code TYPE string;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_code TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_code_expiry ON native_meeting_code FIELDS expires_at;

DEFINE TABLE OVERWRITE native_meeting_invite SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE room ON native_meeting_invite TYPE string;
DEFINE FIELD OVERWRITE recipient ON native_meeting_invite TYPE record<user>;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_invite TYPE datetime;
DEFINE FIELD OVERWRITE revoked_at ON native_meeting_invite TYPE option<datetime>;
DEFINE INDEX OVERWRITE native_meeting_invite_expiry ON native_meeting_invite FIELDS expires_at;

DEFINE TABLE OVERWRITE native_meeting_inbox SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE entries ON native_meeting_inbox TYPE array<object>;
DEFINE FIELD OVERWRITE entries.* ON native_meeting_inbox TYPE object FLEXIBLE;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_inbox TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_inbox_expiry ON native_meeting_inbox FIELDS expires_at;

DEFINE TABLE OVERWRITE native_meeting_presence SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE room ON native_meeting_presence TYPE string;
DEFINE FIELD OVERWRITE join_id ON native_meeting_presence TYPE string;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_presence TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_presence_expiry ON native_meeting_presence FIELDS expires_at;

DEFINE TABLE OVERWRITE native_meeting_join_key SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_join_key TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_join_key_expiry ON native_meeting_join_key FIELDS expires_at;

DEFINE TABLE OVERWRITE native_meeting_create_nonce SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE room ON native_meeting_create_nonce TYPE string;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_create_nonce TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_create_nonce_expiry ON native_meeting_create_nonce FIELDS expires_at;

DEFINE TABLE OVERWRITE native_meeting_rate SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE count ON native_meeting_rate TYPE int;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_rate TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_rate_expiry ON native_meeting_rate FIELDS expires_at;

-- 轮次水位不存 SDP；内容到期可删除，仍不能重放同一轮。
DEFINE TABLE OVERWRITE native_meeting_attempt SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE attempt ON native_meeting_attempt TYPE int;
DEFINE FIELD OVERWRITE nonce ON native_meeting_attempt TYPE string;
DEFINE FIELD OVERWRITE route ON native_meeting_attempt TYPE 'direct' | 'relay';
DEFINE FIELD OVERWRITE expires_at ON native_meeting_attempt TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_attempt_expiry ON native_meeting_attempt FIELDS expires_at;

DEFINE FUNCTION OVERWRITE fn::meeting_valid_hex($value: string) {
  RETURN string::matches($value, '^[0-9a-f]{64}$');
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_room_row($room: string) {
  RETURN SELECT * FROM ONLY type::record('native_meeting_room', $room);
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_member_allowed($room: object, $member: record<user>) {
  IF !fn::signal_member_active($member) {
    RETURN false;
  };
  IF $room.host = $member {
    RETURN true;
  };
  LET $invite = SELECT *
  FROM ONLY type::record(
    'native_meeting_invite',
    [record::id($room.id), $member]
  );
  RETURN $invite != NONE
  AND $invite.revoked_at = NONE
  AND $invite.expires_at > time::now();
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_live($room: object) {
  RETURN array::filter(
    $room.members,
    |$m| $m.lease > time::now() AND fn::meeting_member_allowed($room, $m.member)
  );
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_room_view($room: object, $join_id: string, $members: array) {
  RETURN {
    workspace: session::db(),
    room: {
      id: record::id($room.id),
      code: $room.code,
      host: <string> $room.host,
      status: $room.status,
      version: $room.version,
      expires_unix: time::unix($room.expires_at),
    },
    local_join: $join_id,
    members: array::map(
      $members,
      |$m| {
        member: <string> $m.member,
        join_id: $m.join_id,
        lease_expires_unix: time::unix($m.lease),
      }
    ),
    server_unix: time::unix(time::now()),
  };
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_rate(
  $actor: record<user>,
  $bucket: string,
  $limit: int,
  $window: duration,
) {
  LET $id = type::record('native_meeting_rate', [$actor, $bucket]);
  LET $slot = SELECT * FROM ONLY $id;
  LET $now = time::now();
  IF $slot = NONE
  OR $slot.expires_at <= $now {
    UPSERT $id SET count = 1, expires_at = $now + $window;
  } ELSE {
    IF $slot.count >= $limit {
      THROW 'meeting:rate_limited';
    };
    UPDATE $id SET count += 1;
  };
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_add_presence($room: object, $actor: record<user>, $join_id: string) {
  LET $id = type::record('native_meeting_presence', $actor);
  LET $existing = SELECT * FROM ONLY $id;
  IF $existing != NONE
  AND $existing.expires_at > time::now() {
    LET $other = fn::meeting_room_row($existing.room);
    IF $other != NONE
    AND $other.status = 'open'
    AND $other.expires_at > time::now()
    AND fn::meeting_member_allowed($other, $actor) {
      THROW 'meeting:conflict';
    };
  };
  LET $used = type::record(
    'native_meeting_join_key',
    [record::id($room.id), $join_id]
  );
  IF (
    SELECT VALUE id
    FROM ONLY $used
  ) != NONE {
    THROW 'meeting:conflict';
  };
  CREATE $used SET expires_at = $room.expires_at;
  LET $lease = array::min([time::now() + 45s, $room.expires_at]);
  UPSERT $id SET
    room = record::id($room.id),
    join_id = $join_id,
    expires_at = $lease;
  RETURN {
    member: $actor,
    join_id: $join_id,
    lease: $lease,
  };
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_save_members($room: object, $members: array, $bump: bool) {
  LET $next = array::min(array::map($members, |$m| $m.lease));
  RETURN UPDATE ONLY $room.id SET
    members = $members,
    next_check_at = IF array::len($members) > 0 {
      $next;
    } ELSE {
      NONE;
    },
    status = IF array::len($members) > 0 {
      'open';
    } ELSE {
      'ended';
    },
    version += IF $bump {
      1;
    } ELSE {
      0;
    };
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_create_inner($actor: record<user>, $nonce: string) {
  IF !fn::meeting_valid_hex($nonce) {
    THROW 'meeting:denied';
  };
  LET $key = type::record('native_meeting_create_nonce', [$actor, $nonce]);
  LET $existing = SELECT * FROM ONLY $key;
  IF $existing != NONE {
    RETURN fn::meeting_room_inner($actor, 'snapshot', $existing.room, $nonce);
  };
  fn::meeting_rate($actor, 'create', 3, 30s);
  LET $id = type::record(
    'native_meeting_room',
    crypto::sha256(<string> rand::uuid::v4())
  );
  LET $now = time::now();
  LET $room = CREATE ONLY $id SET
    host = $actor,
    code = string::uppercase(rand::string(20)),
    status = 'open',
    version = 1,
    expires_at = $now + 4h,
    purge_at = $now + 4h + 5m,
    members = [];
  LET $member = fn::meeting_add_presence($room, $actor, $nonce);
  LET $saved = fn::meeting_save_members($room, [$member], false);
  CREATE type::record('native_meeting_code', $room.code) SET
    room = record::id($id),
    expires_at = $room.purge_at;
  CREATE $key SET room = record::id($id), expires_at = $room.purge_at;
  RETURN fn::meeting_room_view($saved, $nonce, $saved.members);
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_join_inner($actor: record<user>, $code: string, $join_id: string) {
  IF !string::matches($code, '^[A-Z0-9]{8,32}$') {
    THROW 'meeting:not_found';
  };
  LET $lookup = SELECT VALUE room
  FROM ONLY type::record('native_meeting_code', $code);
  IF $lookup = NONE {
    THROW 'meeting:not_found';
  };
  LET $room = fn::meeting_room_row($lookup);
  IF $room = NONE OR !fn::meeting_member_allowed($room, $actor) {
    THROW 'meeting:not_found';
  };
  IF !fn::meeting_valid_hex($join_id) {
    THROW 'meeting:denied';
  };
  IF $room.status != 'open'
  OR $room.expires_at <= time::now() {
    THROW 'meeting:expired';
  };
  LET $active = fn::meeting_live($room);
  IF array::len($active) = 0 {
    THROW 'meeting:expired';
  };
  LET $existing = array::find($active, |$m| $m.member = $actor);
  IF $existing != NONE {
    IF $existing.join_id != $join_id {
      THROW 'meeting:conflict';
    };
    RETURN fn::meeting_room_view($room, $join_id, $active);
  };
  IF array::len($active) >= 4 {
    THROW 'meeting:full';
  };
  fn::meeting_rate($actor, 'join', 8, 15s);
  LET $member = fn::meeting_add_presence($room, $actor, $join_id);
  LET $saved = fn::meeting_save_members(
    $room,
    array::append($active, $member),
    true
  );
  RETURN fn::meeting_room_view($saved, $join_id, $saved.members);
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_room_inner(
  $actor: record<user>,
  $op: string,
  $id: string,
  $join_id: string,
) {
  IF !fn::meeting_valid_hex($id) OR !fn::meeting_valid_hex($join_id) {
    THROW 'meeting:not_found';
  };
  LET $room = fn::meeting_room_row($id);
  IF $room = NONE OR !fn::meeting_member_allowed($room, $actor) {
    THROW 'meeting:not_found';
  };
  LET $stored = array::find(
    $room.members,
    |$m| $m.member = $actor
    AND $m.join_id = $join_id
  );
  IF $op = 'leave'
  AND $stored = NONE {
    RETURN NONE;
  };
  IF $stored = NONE {
    THROW 'meeting:not_found';
  };
  IF $op = 'end'
  AND $room.host != $actor {
    THROW 'meeting:denied';
  };
  IF $room.status = 'ended' {
    IF $op = 'end'
    OR $op = 'leave' {
      RETURN NONE;
    };
    IF $op = 'snapshot' {
      RETURN fn::meeting_room_view($room, $join_id, []);
    };
    THROW 'meeting:expired';
  };
  IF $room.expires_at <= time::now()
  OR $stored.lease <= time::now() {
    IF $op = 'leave' {
      RETURN NONE;
    };
    THROW 'meeting:expired';
  };
  LET $active = fn::meeting_live($room);
  LET $pruned = array::len($active) != array::len($room.members);
  IF $op = 'snapshot' {
    LET $saved = IF $pruned {
      fn::meeting_save_members($room, $active, true);
    } ELSE {
      $room;
    };
    RETURN fn::meeting_room_view($saved, $join_id, $active);
  };
  IF $op = 'renew' {
    LET $lease = array::min([time::now() + 45s, $room.expires_at]);
    LET $renewed = IF $lease > $stored.lease + 5s {
      UPDATE type::record('native_meeting_presence', $actor) SET
        expires_at = $lease
      WHERE
        room = $id
        AND join_id = $join_id;
      array::map(
        $active,
        |$m| IF $m.member = $actor {
          {
            member: $actor,
            join_id: $join_id,
            lease: $lease,
          };
        } ELSE {
          $m;
        }
      );
    } ELSE {
      $active;
    };
    LET $saved = IF $pruned
    OR $renewed != $active {
      fn::meeting_save_members($room, $renewed, $pruned);
    } ELSE {
      $room;
    };
    RETURN fn::meeting_room_view($saved, $join_id, $saved.members);
  };
  IF $op = 'leave' {
    DELETE type::record('native_meeting_presence', $actor)
    WHERE
      room = $id
      AND join_id = $join_id;
    fn::meeting_save_members(
      $room,
      array::filter($active, |$m| $m.member != $actor),
      true
    );
    RETURN NONE;
  };
  IF $op = 'end' {
    UPDATE $room.id SET
      status = 'ended',
      version += 1,
      members = $active,
      next_check_at = NONE
    WHERE status = 'open';
    RETURN NONE;
  };
  THROW 'meeting:denied';
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_invite_inner($actor: record<user>, $id: string, $recipients: array<string>) {
  IF !fn::meeting_valid_hex($id) {
    THROW 'meeting:not_found';
  };
  LET $room = fn::meeting_room_row($id);
  IF $room = NONE
  OR $room.host != $actor {
    THROW 'meeting:not_found';
  };
  IF $room.status != 'open'
  OR $room.expires_at <= time::now()
  OR array::find(fn::meeting_live($room), |$m| $m.member = $actor) = NONE {
    THROW 'meeting:expired';
  };
  IF array::len($recipients) = 0
  OR array::len($recipients) > 20 {
    THROW 'meeting:denied';
  };
  fn::meeting_rate($actor, 'invite', 4, 10s);
  LET $unique = array::distinct($recipients);
  LET $new = array::filter(
    $unique,
    |$key| !(
      SELECT VALUE id
      FROM ONLY type::record(
        'native_meeting_invite',
        [$id, type::record('user', $key)]
      )
    )
  );
  IF $room.invite_count + array::len($new) > 64 {
    THROW 'meeting:rate_limited';
  };
  FOR $key IN $unique {
    LET $recipient = type::record('user', $key);
    IF !string::matches($key, '^[A-Za-z0-9_]{1,128}$')
    OR $recipient = $actor
    OR !fn::signal_member_active($recipient) {
      THROW 'meeting:denied';
    };
    LET $invite = type::record('native_meeting_invite', [$id, $recipient]);
    LET $existing = SELECT * FROM ONLY $invite;
    IF $existing.revoked_at != NONE {
      THROW 'meeting:denied';
    };
    IF $existing = NONE {
      CREATE $invite SET
        room = $id,
        recipient = $recipient,
        expires_at = $room.expires_at;
      LET $inbox_id = type::record('native_meeting_inbox', $recipient);
      LET $inbox = SELECT * FROM ONLY $inbox_id;
      LET $now = time::now();
      LET $valid = array::filter(
        $inbox.entries ?? [],
        |$entry| $entry.expires_at > $now
      );
      IF array::len($valid) >= 64 {
        THROW 'meeting:rate_limited';
      };
      UPSERT $inbox_id SET
        entries = array::prepend(
          $valid,
          { room: $id, expires_at: $room.expires_at }
        ),
        expires_at = array::max([$room.expires_at, $inbox.expires_at ?? $now]);
    };
  };
  -- 与主持人离开/房间结束串行。邀请不会改变成员快照。
  UPDATE $room.id SET
    invite_count += array::len($new)
  WHERE array::len($new) > 0;
  RETURN {
    room: $id,
    invited: array::map($unique, |$key| <string> type::record('user', $key)),
  };
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_invitations_inner($actor: record<user>) {
  LET $now = time::now();
  LET $entries = SELECT VALUE entries
  FROM ONLY type::record('native_meeting_inbox', $actor);
  LET $visible = array::filter(
    array::map(
      $entries ?? [],
      |$i| {
        LET $room = fn::meeting_room_row($i.room);
        IF $i.expires_at <= $now
        OR $room = NONE
        OR $room.status != 'open'
        OR $room.expires_at <= $now
        OR !fn::meeting_member_allowed($room, $actor)
        OR array::len(fn::meeting_live($room)) = 0 {
          RETURN NONE;
        };
        RETURN {
          workspace: session::db(),
          room: $i.room,
          code: $room.code,
          host: <string> $room.host,
          expires_unix: time::unix($i.expires_at),
          server_unix: time::unix($now),
        };
      }
    ),
    |$i| $i != NONE
  );
  RETURN array::slice($visible, 0, 20);
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_actor() {
    LET $actor = $auth.id;
    IF session::ac() != 'participant'
    OR $actor = NONE
    OR record::tb($actor) != 'user'
    OR !fn::signal_member_active($actor) {
      THROW 'meeting:denied';
    };
    RETURN $actor;
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_edge_visible(
  $id: string,
  $sender: record<user>,
  $sender_join: string,
  $recipient: record<user>,
  $recipient_join: string,
) {
  IF $auth.id NOT IN [$sender, $recipient] {
    RETURN false;
  };
  LET $room = fn::meeting_room_row($id);
  IF $room = NONE
  OR $room.status != 'open'
  OR $room.expires_at <= time::now() {
    RETURN false;
  };
  IF !fn::meeting_member_allowed($room, $sender)
  OR !fn::meeting_member_allowed($room, $recipient) {
    RETURN false;
  };
  LET $now = time::now();
  RETURN array::find(
    $room.members,
    |$m| $m.member = $sender
    AND $m.join_id = $sender_join
    AND $m.lease > $now
  ) != NONE
  AND array::find(
    $room.members,
    |$m| $m.member = $recipient
    AND $m.join_id = $recipient_join
    AND $m.lease > $now
  ) != NONE;
} PERMISSIONS FULL;

DEFINE TABLE OVERWRITE native_meeting_payload SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE room ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE sender ON native_meeting_payload TYPE record<user>;
DEFINE FIELD OVERWRITE sender_join ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE recipient ON native_meeting_payload TYPE record<user>;
DEFINE FIELD OVERWRITE recipient_join ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE attempt ON native_meeting_payload TYPE int;
DEFINE FIELD OVERWRITE nonce ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE route ON native_meeting_payload TYPE 'direct' | 'relay';
DEFINE FIELD OVERWRITE wire_id ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE offer ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE offer_hash ON native_meeting_payload TYPE string;
DEFINE FIELD OVERWRITE answer ON native_meeting_payload TYPE option<string>;
DEFINE FIELD OVERWRITE answer_hash ON native_meeting_payload TYPE option<string>;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_payload TYPE datetime;
DEFINE INDEX OVERWRITE native_meeting_payload_expiry ON native_meeting_payload FIELDS expires_at;

DEFINE FUNCTION OVERWRITE fn::meeting_sdp_view($row: object) {
  RETURN {
    workspace: session::db(),
    room: $row.room,
    id: $row.wire_id,
    sender: <string> $row.sender,
    sender_join: $row.sender_join,
    recipient: <string> $row.recipient,
    recipient_join: $row.recipient_join,
    attempt: $row.attempt,
    nonce: $row.nonce,
    route: $row.route,
    offer: $row.offer,
    offer_hash: $row.offer_hash,
    answer: $row.answer,
    answer_hash: $row.answer_hash,
    expires_unix: time::unix($row.expires_at),
    server_unix: time::unix(time::now()),
  };
} PERMISSIONS FULL;

-- json::decode 的解析错误不能捕获；先校验窄协议的两个 JSON 字符串，保留固定错误码。
DEFINE FUNCTION OVERWRITE fn::meeting_sdp_json($raw: string) {
  LET $ws = '[\\x20\\t\\r\\n]*';
  LET $hex = '[0-9a-fA-F]';
  LET $escape = string::join('',
    '\\\\(?:["\\\\/bfnrt]|u(?:[0-9a-cA-Ce-fE-F]', $hex, '{3}|[dD][0-7]', $hex, '{2}',
    '|[dD][89a-bA-B]', $hex, '{2}\\\\u[dD][c-fC-F]', $hex, '{2}))'
  );
  LET $quoted = string::join('', '"(?:[^"\\\\\\x00-\\x1f]|', $escape, ')*"');
  LET $type = string::join('', '"type"', $ws, ':', $ws, $quoted);
  LET $sdp = string::join('', '"sdp"', $ws, ':', $ws, $quoted);
  LET $comma = string::join('', $ws, ',', $ws);
  RETURN string::matches($raw, string::join('', '^', $ws, '\\{', $ws,
    '(?:', $type, $comma, $sdp, '|', $sdp, $comma, $type, ')', $ws, '\\}', $ws, '\\z'));
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_sdp_inner($actor: record<user>, $op: string, $input: object) {
  LET $id = <string> $input.room;
  LET $join_id = <string> $input.join_id;
  LET $peer_join = <string> $input.peer_join_id;
  LET $attempt = <int> $input.attempt;
  LET $nonce = <string> $input.nonce;
  IF !fn::meeting_valid_hex($id)
  OR !fn::meeting_valid_hex($join_id)
  OR !fn::meeting_valid_hex($peer_join)
  OR !fn::meeting_valid_hex($nonce)
  OR $attempt < 1
  OR $attempt > 4294967295 {
    THROW 'meeting:denied';
  };
  LET $is_offer = $op = 'post_offer';
  IF (
    $is_offer
    AND $join_id >= $peer_join
  )
  OR (
    !$is_offer
    AND $join_id <= $peer_join
  ) {
    THROW 'meeting:denied';
  };
  LET $room = fn::meeting_room_row($id);
  IF $room = NONE OR !fn::meeting_member_allowed($room, $actor) {
    THROW 'meeting:not_found';
  };
  IF $room.status != 'open'
  OR $room.expires_at <= time::now() {
    THROW 'meeting:expired';
  };
  LET $members = fn::meeting_live($room);
  LET $local_member = array::find(
    $members,
    |$m| $m.member = $actor
    AND $m.join_id = $join_id
  );
  LET $peer = array::find($members, |$m| $m.join_id = $peer_join);
  IF $local_member = NONE
  OR $peer = NONE {
    THROW 'meeting:not_found';
  };
  LET $sender = IF $is_offer {
    $local_member;
  } ELSE {
    $peer;
  };
  LET $recipient = IF $is_offer {
    $peer;
  } ELSE {
    $local_member;
  };
  LET $edge = [$id, $sender.join_id, $recipient.join_id];
  LET $watermark = type::record('native_meeting_attempt', $edge);
  LET $payload = type::record('native_meeting_payload', $edge);
  LET $current = SELECT * FROM ONLY $watermark;
  LET $kind = IF $is_offer {
    'offer';
  } ELSE {
    'answer';
  };
  LET $raw = <string> (
    IF $is_offer {
      $input.offer;
    } ELSE {
      $input.answer;
    }
  );
  LET $hash = <string> (
    IF $is_offer {
      $input.offer_hash;
    } ELSE {
      $input.answer_hash;
    }
  );
  IF string::len($raw) > 49152
  OR !string::matches($raw, '^[\\x00-\\x7f]*$')
  OR crypto::sha256($raw) != $hash
  OR !fn::meeting_sdp_json($raw)
  OR !fn::signal_sdp($raw, $kind) {
    THROW 'meeting:denied';
  };
  fn::meeting_rate($actor, 'post_sdp', 12, 10s);
  IF $is_offer {
    LET $route = <string> $input.route;
    IF $route NOT IN ['direct', 'relay']
    OR (
      $current = NONE
      AND $route != 'direct'
    ) {
      THROW 'meeting:denied';
    };
    IF $current != NONE
    AND (
      $attempt <= $current.attempt
    ) {
      THROW 'meeting:conflict';
    };
    LET $expiry = array::min([time::now() + 30s, $room.expires_at]);
    UPSERT $watermark SET
      attempt = $attempt,
      nonce = $nonce,
      route = $route,
      expires_at = $room.expires_at;
    UPSERT $payload CONTENT {
      room: $id,
      sender: $sender.member,
      sender_join: $sender.join_id,
      recipient: $recipient.member,
      recipient_join: $recipient.join_id,
      attempt: $attempt,
      nonce: $nonce,
      route: $route,
      wire_id: crypto::sha256(
        string::join(
          ':',
          $id,
          $sender.join_id,
          $recipient.join_id,
          <string> $attempt,
          $nonce
        )
      ),
      offer: $raw,
      offer_hash: $hash,
      expires_at: $expiry,
    };
  } ELSE {
    IF $current = NONE
    OR $current.attempt != $attempt
    OR $current.nonce != $nonce {
      THROW 'meeting:conflict';
    };
    LET $existing = SELECT * FROM ONLY $payload;
    IF $existing = NONE
    OR $existing.expires_at <= time::now() {
      THROW 'meeting:expired';
    };
    IF $existing.offer_hash != $input.offer_hash
    OR $existing.answer != NONE
    OR $existing.sender != $sender.member
    OR $existing.recipient != $actor {
      THROW 'meeting:conflict';
    };
    UPDATE $payload SET answer = $raw, answer_hash = $hash;
  };
  -- 与离开、撤回成员资格后的 roster 更新及结束共享房间写栅栏。
  UPDATE $room.id SET signal_revision += 1;
  RETURN fn::meeting_sdp_view(SELECT * FROM ONLY $payload);
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_poll_inner(
  $actor: record<user>,
  $op: string,
  $room: string,
  $join_id: string,
) {
  LET $snapshot = fn::meeting_room_inner($actor, 'snapshot', $room, $join_id);
  IF $snapshot.room.status != 'open' {
    THROW 'meeting:expired';
  };
  fn::meeting_rate($actor, $op, 12, 10s);
  LET $now = time::now();
  LET $incoming = $op = 'poll_offers';
  LET $peers = array::filter(
    $snapshot.members,
    |$m| IF $incoming {
      $m.join_id < $join_id;
    } ELSE {
      $m.join_id > $join_id;
    }
  );
  LET $ids = array::map(
    $peers,
    |$m| type::record(
      'native_meeting_payload',
      IF $incoming {
        [$room, $m.join_id, $join_id];
      } ELSE {
        [$room, $join_id, $m.join_id];
      }
    )
  );
  LET $rows = SELECT * FROM $ids;
  RETURN array::map(
    array::filter(
      $rows,
      |$row| $row != NONE
      AND $row.expires_at > $now
      AND IF $incoming {
        $row.recipient = $actor
        AND $row.answer = NONE;
      } ELSE {
        $row.sender = $actor
        AND $row.answer != NONE;
      }
    ),
    |$row| fn::meeting_sdp_view($row)
  );
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_dispatch($actor: record<user>, $op: string, $input: object) {
  IF $op = 'create' {
    RETURN fn::meeting_create_inner($actor, $input.nonce);
  };
  IF $op = 'join' {
    RETURN fn::meeting_join_inner($actor, $input.code, $input.join_id);
  };
  IF $op = 'invite' {
    RETURN fn::meeting_invite_inner($actor, $input.room, $input.recipients);
  };
  IF $op = 'invitations' {
    fn::meeting_rate($actor, 'invitations', 20, 10s);
    RETURN fn::meeting_invitations_inner($actor);
  };
  IF $op IN ['snapshot', 'renew', 'leave', 'end'] {
    IF $op IN ['snapshot', 'renew'] {
      fn::meeting_rate($actor, $op, 30, 10s);
    };
    RETURN fn::meeting_room_inner($actor, $op, $input.room, $input.join_id);
  };
  IF $op IN ['post_offer', 'post_answer'] {
    RETURN fn::meeting_sdp_inner($actor, $op, $input);
  };
  IF $op IN ['poll_offers', 'poll_answers'] {
    RETURN fn::meeting_poll_inner($actor, $op, $input.room, $input.join_id);
  };
  THROW 'meeting:denied';
} PERMISSIONS NONE;

DEFINE FUNCTION OVERWRITE fn::meeting_receipt_visible($actor: record<user>, $op: string, $value: any) {
  IF $actor != $auth.id OR !fn::signal_member_active($actor) {
    RETURN false;
  };
  IF $op IN ['create', 'join', 'snapshot', 'renew'] {
    IF $value.room.id = NONE {
      RETURN false;
    };
    LET $room = fn::meeting_room_row($value.room.id);
    IF $room = NONE OR $room.version != $value.room.version OR !fn::meeting_member_allowed($room, $actor) {
      RETURN false;
    };
    LET $join_id = $value.local_join;
    LET $now = time::now();
    RETURN (
      $room.status = 'ended'
      OR $room.expires_at > $now
    )
    AND array::find(
      $room.members,
      |$m| $m.member = $actor
      AND $m.join_id = $join_id
      AND (
        $room.status = 'ended'
        OR $m.lease > $now
      )
    ) != NONE;
  };
  IF $op = 'invitations' {
    IF $value = NONE {
      RETURN false;
    };
    FOR $i IN $value {
      LET $room = fn::meeting_room_row($i.room);
      IF $room = NONE
      OR $room.status != 'open'
      OR $room.expires_at <= time::now()
      OR !fn::meeting_member_allowed($room, $actor) {
        RETURN false;
      };
    };
    RETURN true;
  };
  IF $op IN ['post_offer', 'post_answer', 'poll_offers', 'poll_answers'] {
    IF $value = NONE {
      RETURN false;
    };
    LET $rows = IF $op IN ['post_offer', 'post_answer'] {
      [$value];
    } ELSE {
      $value;
    };
    FOR $row IN $rows {
      IF !fn::meeting_edge_visible(
        $row.room,
        type::record($row.sender),
        $row.sender_join,
        type::record($row.recipient),
        $row.recipient_join
      ) {
        RETURN false;
      };
      LET $payload = SELECT wire_id, answer_hash, expires_at
      FROM ONLY type::record(
        'native_meeting_payload',
        [$row.room, $row.sender_join, $row.recipient_join]
      );
      IF $payload.wire_id != $row.id
      OR $payload.expires_at <= time::now()
      OR $payload.answer_hash != $row.answer_hash {
        RETURN false;
      };
    };
    RETURN true;
  };
  RETURN true;
} PERMISSIONS FULL;

-- 仅 CREATE 触发同步事件。事件在本事务内访问私表；RPC 成功返回即删除收据。
-- 每人每操作一个槽，即使绕过 RPC 外壳直接写入也不能堆积收据或跳过验证。
DEFINE TABLE OVERWRITE native_meeting_command SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      session::ac() = 'participant'
      AND actor = $auth.id
      AND expires_at > time::now()
      AND fn::meeting_receipt_visible(actor, op, receipt.value)
    FOR create, delete WHERE
      session::ac() = 'participant'
      AND actor = $auth.id
    FOR update NONE;
DEFINE FIELD OVERWRITE actor ON native_meeting_command TYPE record<user>
  VALUE $auth.id;
DEFINE FIELD OVERWRITE op ON native_meeting_command TYPE string;
DEFINE FIELD OVERWRITE input ON native_meeting_command TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE receipt ON native_meeting_command TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE expires_at ON native_meeting_command TYPE datetime
  VALUE time::now() + 2s;
DEFINE INDEX OVERWRITE native_meeting_command_expiry ON native_meeting_command FIELDS expires_at;
DEFINE EVENT OVERWRITE native_meeting_command_gate ON native_meeting_command
  WHEN $event = 'CREATE'
  THEN {
    LET $actor = fn::meeting_actor();
    IF $after.id != type::record('native_meeting_command', [$actor, $after.op])
    OR $after.receipt != NONE {
      THROW 'meeting:denied';
    };
    LET $response = fn::meeting_dispatch($actor, $after.op, $after.input);
    UPDATE $after.id SET input = NONE, receipt = { value: $response };
  };

DEFINE FUNCTION OVERWRITE fn::meeting_call($op: string, $input: object) {
  LET $actor = fn::meeting_actor();
  LET $id = type::record('native_meeting_command', [$actor, $op]);
  DELETE $id;
  CREATE $id SET op = $op, input = $input;
  LET $result = SELECT VALUE receipt FROM ONLY $id;
  DELETE $id;
  IF $result = NONE {
    THROW 'meeting:conflict';
  };
  RETURN $result.value;
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_capability() {
    fn::meeting_actor();
    RETURN 'meeting_v1';
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_create($nonce: string) {
  RETURN fn::meeting_call('create', { nonce: $nonce });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_invite($room: string, $recipients: array<string>) {
  RETURN fn::meeting_call('invite', { room: $room, recipients: $recipients });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_invitations() {
    RETURN fn::meeting_call('invitations', {});
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_join($code: string, $join_id: string) {
  RETURN fn::meeting_call('join', { code: $code, join_id: $join_id });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_snapshot($room: string, $join_id: string) {
  RETURN fn::meeting_call('snapshot', { room: $room, join_id: $join_id });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_renew($room: string, $join_id: string) {
  RETURN fn::meeting_call('renew', { room: $room, join_id: $join_id });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_leave($room: string, $join_id: string) {
  RETURN fn::meeting_call('leave', { room: $room, join_id: $join_id });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_end($room: string, $join_id: string) {
  RETURN fn::meeting_call('end', { room: $room, join_id: $join_id });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_post_offer(
  $room: string,
  $join_id: string,
  $peer_join_id: string,
  $attempt: int,
  $nonce: string,
  $route: string,
  $offer: string,
  $offer_hash: string,
) {
  RETURN fn::meeting_call(
    'post_offer',
    {
      room: $room,
      join_id: $join_id,
      peer_join_id: $peer_join_id,
      attempt: $attempt,
      nonce: $nonce,
      route: $route,
      offer: $offer,
      offer_hash: $offer_hash,
    }
  );
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_poll_offers($room: string, $join_id: string) {
  RETURN fn::meeting_call('poll_offers', { room: $room, join_id: $join_id });
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_post_answer(
  $room: string,
  $join_id: string,
  $peer_join_id: string,
  $attempt: int,
  $nonce: string,
  $offer_hash: string,
  $answer: string,
  $answer_hash: string,
) {
  RETURN fn::meeting_call(
    'post_answer',
    {
      room: $room,
      join_id: $join_id,
      peer_join_id: $peer_join_id,
      attempt: $attempt,
      nonce: $nonce,
      offer_hash: $offer_hash,
      answer: $answer,
      answer_hash: $answer_hash,
    }
  );
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::meeting_poll_answers($room: string, $join_id: string) {
  RETURN fn::meeting_call('poll_answers', { room: $room, join_id: $join_id });
} PERMISSIONS FULL;

-- 仅维护会话调用；没有客户端在线时也要删除 SDP。每次调用处理有界批次。
DEFINE FUNCTION OVERWRITE fn::meeting_gc() {
    LET $now = time::now();
    LET $due = SELECT *
    FROM native_meeting_room
    WHERE
      next_check_at <= $now
      AND next_check_at != NONE
    LIMIT 128;
    FOR $room IN $due {
      LET $members = IF $room.expires_at <= $now {
        [];
      } ELSE {
        fn::meeting_live($room);
      };
      IF array::len($members) != array::len($room.members) {
        fn::meeting_save_members($room, $members, true);
      };
    };
    LET $payloads = SELECT VALUE id
    FROM native_meeting_payload
    WHERE expires_at <= $now
    LIMIT 128;
    DELETE $payloads;
    DELETE (
      SELECT VALUE id
      FROM native_meeting_attempt
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_invite
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_inbox
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_presence
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_join_key
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_create_nonce
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_code
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_rate
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_command
      WHERE expires_at <= $now
      LIMIT 128
    );
    DELETE (
      SELECT VALUE id
      FROM native_meeting_room
      WHERE purge_at <= $now
      LIMIT 128
    );
    RETURN array::len($due) = 128 OR array::len($payloads) = 128;
} PERMISSIONS NONE;
