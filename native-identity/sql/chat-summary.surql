LET $conversation = SELECT * FROM ONLY type::record($room);
LET $read = (SELECT VALUE last_read_at FROM chat_member
  WHERE conversation = type::record($room) AND user = $auth.id LIMIT 1)[0];
RETURN {
  id: $conversation.id,
  kind: $conversation.kind,
  title: $conversation.title,
  member_count: ((SELECT count() AS n FROM chat_member WHERE conversation = type::record($room) GROUP ALL)[0].n ?? 0),
  peer: IF $conversation.kind = 'direct' {
    (SELECT user AS id, (user.display_name ?? user.email) AS display_name
      FROM chat_member WHERE conversation = type::record($room) AND user != $auth.id LIMIT 1)[0]
  } ELSE { NONE },
  last_message: (SELECT * FROM chat_message WHERE conversation = type::record($room)
    ORDER BY created_at DESC, id DESC LIMIT 1)[0],
  unread_count: ((SELECT count() AS n FROM chat_message
    WHERE conversation = type::record($room) AND sender != $auth.id
      AND ($read = NONE OR created_at > $read) GROUP ALL)[0].n ?? 0)
};
