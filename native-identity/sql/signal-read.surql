SELECT
  *,
  type::string(record::id(id)) AS id,
  time::now() AS server_now,
  time::unix(expires_at) AS expires_unix,
  time::unix(time::now()) AS server_unix
FROM type::record('native_signal', $id)
WHERE
  workspace = $workspace
  AND expires_at > time::now();
