BEGIN TRANSACTION;
LET $room = CREATE ONLY chat_conversation CONTENT {
  kind: 'group', title: type::string_lossy(encoding::base64::decode($title64))
};
FOR $member IN array::distinct($members) {
  IF type::record($member) != $auth.id {
    LET $joined = CREATE chat_member CONTENT {
      conversation: $room.id, user: type::record($member), role: 'member'
    };
    IF array::len($joined) != 1 { THROW 'chat: member rejected'; };
  };
};
COMMIT TRANSACTION;
RETURN $room.id;
