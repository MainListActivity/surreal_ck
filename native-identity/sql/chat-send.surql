LET $body = type::string_lossy(encoding::base64::decode($body64));
LET $client = type::string_lossy(encoding::base64::decode($client64));
INSERT INTO chat_message {
  conversation: type::record($room), body: $body, client_id: $client
} ON DUPLICATE KEY UPDATE client_id = $client;
SELECT * FROM chat_message WHERE sender = $auth.id AND client_id = $client LIMIT 1;
