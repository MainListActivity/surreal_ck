SELECT * FROM chat_message WHERE conversation = type::record($room)
  AND ($id = '' OR created_at < <datetime>$time
    OR (created_at = <datetime>$time AND id < type::record($id)))
ORDER BY created_at DESC, id DESC LIMIT $limit;
