UPDATE type::record('native_signal', $id) SET
  status = 'ended'
WHERE
  workspace = $workspace
  AND sender = type::record('user', $sender)
  AND recipient = type::record('user', $recipient)
  AND nonce = $nonce
  AND generation = $generation
  AND offer_hash = $offer_hash
  AND expires_at = <datetime> $expires_at
  AND expires_at > time::now()
  AND status IN ['pending', 'accepted', 'answered']
RETURN *,
type::string(record::id(id)) AS id,
time::now() AS server_now,
time::unix(expires_at) AS expires_unix,
time::unix(time::now()) AS server_unix;
