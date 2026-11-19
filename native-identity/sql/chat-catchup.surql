SELECT * FROM chat_message
WHERE created_at >= <datetime>$since - 1s * $overlap
  AND created_at <= <datetime>$until
  AND ($after_id = '' OR created_at > <datetime>$after_time
    OR (created_at = <datetime>$after_time AND id > type::record($after_id)))
ORDER BY created_at ASC, id ASC LIMIT 100;
