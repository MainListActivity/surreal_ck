SELECT type::string(id) AS id
FROM user
WHERE
  id = $auth.id
  AND subject = $subject
  AND kind = 'human'
  AND disabled_at = NONE
LIMIT 1;
