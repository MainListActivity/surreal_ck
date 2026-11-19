DEFINE FUNCTION OVERWRITE fn::chat_active($who: record<user>) {
  RETURN array::len(SELECT VALUE id FROM user WHERE id = $who AND kind = 'human' AND disabled_at = NONE) = 1;
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::chat_joined($room: record<chat_conversation>, $who: record<user>) {
  RETURN fn::chat_active($who) AND array::len(SELECT VALUE id FROM chat_member WHERE conversation = $room AND user = $who LIMIT 1) = 1;
} PERMISSIONS FULL;

DEFINE FUNCTION OVERWRITE fn::chat_group_owner($room: record<chat_conversation>, $who: record<user>) {
  RETURN $room.kind = 'group' AND fn::chat_active($who) AND array::len(SELECT VALUE id FROM chat_member WHERE conversation = $room AND user = $who AND role = 'owner' LIMIT 1) = 1;
} PERMISSIONS FULL;

DEFINE TABLE OVERWRITE chat_conversation SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE AND fn::chat_joined(id, $auth.id)
    FOR create WHERE $auth != NONE AND created_by = $auth.id AND fn::chat_active($auth.id)
    FOR update, delete NONE;
DEFINE FIELD OVERWRITE kind ON chat_conversation TYPE 'direct' | 'group';
DEFINE FIELD OVERWRITE title ON chat_conversation TYPE option<string>;
DEFINE FIELD OVERWRITE direct_users ON chat_conversation TYPE array<record<user>> DEFAULT [];
DEFINE FIELD OVERWRITE direct_key ON chat_conversation TYPE option<string>
  VALUE IF $this.kind = 'direct' { encoding::json::encode(array::sort($this.direct_users.map(|$u| <string>$u))) } ELSE { NONE };
DEFINE FIELD OVERWRITE created_by ON chat_conversation TYPE record<user> DEFAULT $auth.id;
DEFINE FIELD OVERWRITE created_at ON chat_conversation TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX OVERWRITE chat_direct_pair ON chat_conversation FIELDS direct_key UNIQUE;

DEFINE TABLE OVERWRITE chat_member SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE AND fn::chat_active($auth.id) AND (user = $auth.id OR fn::chat_joined(conversation, $auth.id))
    FOR create WHERE $auth != NONE AND role = 'member' AND fn::chat_active(user) AND fn::chat_group_owner(conversation, $auth.id)
    FOR update WHERE $auth != NONE AND user = $auth.id AND fn::chat_joined(conversation, $auth.id)
    FOR delete WHERE $auth != NONE AND role != 'owner' AND fn::chat_group_owner(conversation, $auth.id);
DEFINE FIELD OVERWRITE conversation ON chat_member TYPE record<chat_conversation> PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE user ON chat_member TYPE record<user> PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE role ON chat_member TYPE 'owner' | 'member' PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE joined_at ON chat_member TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD OVERWRITE last_read_at ON chat_member TYPE option<datetime>
  ASSERT $value = NONE OR $value <= time::now();
DEFINE INDEX OVERWRITE chat_membership ON chat_member FIELDS conversation, user UNIQUE;
DEFINE INDEX OVERWRITE chat_member_user ON chat_member FIELDS user, conversation;

DEFINE TABLE OVERWRITE chat_message SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE AND fn::chat_joined(conversation, $auth.id)
    FOR create WHERE $auth != NONE AND sender = $auth.id AND fn::chat_joined(conversation, $auth.id)
    FOR update, delete NONE;
DEFINE FIELD OVERWRITE conversation ON chat_message TYPE record<chat_conversation>;
DEFINE FIELD OVERWRITE sender ON chat_message TYPE record<user> DEFAULT $auth.id;
DEFINE FIELD OVERWRITE body ON chat_message TYPE string ASSERT string::len(string::trim($value)) > 0 AND string::len($value) <= 4000;
DEFINE FIELD OVERWRITE client_id ON chat_message TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD OVERWRITE created_at ON chat_message TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX OVERWRITE chat_message_client ON chat_message FIELDS sender, client_id UNIQUE;
DEFINE INDEX OVERWRITE chat_message_history ON chat_message FIELDS conversation, created_at;

DEFINE EVENT OVERWRITE chat_conversation_created ON chat_conversation WHEN $event = 'CREATE' THEN {
  IF $auth = NONE OR $after.created_by != $auth.id OR !fn::chat_active($auth.id) {
    THROW 'chat: active creator required';
  };
  IF $after.kind = 'direct' {
    IF array::len($after.direct_users) != 2 OR array::len(array::distinct($after.direct_users)) != 2
      OR $auth.id NOTINSIDE $after.direct_users {
      THROW 'chat: direct requires self and one peer';
    };
    FOR $who IN $after.direct_users {
      IF !fn::chat_active($who) { THROW 'chat: inactive peer'; };
      CREATE chat_member CONTENT { conversation: $after.id, user: $who, role: IF $who = $auth.id { 'owner' } ELSE { 'member' } };
    };
  } ELSE {
    IF $after.title = NONE OR string::len(string::trim($after.title)) = 0 OR string::len($after.title) > 200
      OR array::len($after.direct_users) != 0 {
      THROW 'chat: group title required';
    };
    CREATE chat_member CONTENT { conversation: $after.id, user: $auth.id, role: 'owner' };
  };
};

DEFINE EVENT OVERWRITE chat_member_update_guard ON chat_member WHEN $event = 'UPDATE' THEN {
  IF $auth = NONE OR $before.user != $auth.id OR !fn::chat_joined($before.conversation, $auth.id)
    OR $before.conversation != $after.conversation OR $before.user != $after.user
    OR $before.role != $after.role OR $before.joined_at != $after.joined_at {
    THROW 'chat: only own read cursor may change';
  };
};

DEFINE FUNCTION OVERWRITE fn::chat_direct($peer: record<user>) {
  IF $auth = NONE { THROW 'chat: participant required'; };
  IF $peer = $auth.id OR !fn::chat_active($auth.id) OR !fn::chat_active($peer) {
    THROW 'chat: two active humans required';
  };
  LET $key = encoding::json::encode(array::sort([<string>$auth.id, <string>$peer]));
  INSERT INTO chat_conversation { kind: 'direct', direct_users: [$auth.id, $peer] } ON DUPLICATE KEY UPDATE direct_key = $key;
  LET $existing = SELECT VALUE id FROM chat_conversation WHERE direct_key = $key LIMIT 1;
  IF array::len($existing) != 1 { THROW 'chat: direct creation failed'; };
  RETURN $existing[0];
} PERMISSIONS FULL;
