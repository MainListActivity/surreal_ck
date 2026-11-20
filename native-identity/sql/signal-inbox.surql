SELECT
  type::string(record::id(id)) AS id,
  type::string(sender) AS sender,
  expires_at,
  time::now() AS server_now,
  time::unix(expires_at) AS expires_unix,
  time::unix(time::now()) AS server_unix
FROM native_signal
WHERE
  recipient = $auth.id
  AND workspace = $workspace
  AND status = 'pending'
  AND expires_at > time::now()
ORDER BY expires_at DESC
LIMIT 50;
