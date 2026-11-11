CREATE type::record('native_signal', $id) SET
  workspace = $workspace,
  sender = $auth.id,
  recipient = type::record('user', $recipient),
  nonce = $nonce,
  generation = $generation,
  offer = $offer,
  offer_hash = $offer_hash,
  status = 'pending'
RETURN *,
type::string(record::id(id)) AS id,
time::now() AS server_now,
time::unix(expires_at) AS expires_unix,
time::unix(time::now()) AS server_unix;
