-- 仅低流量协商；媒体、聊天正文、文件和账户 token 不属于此 schema。
-- JWT Owner / root 是可信控制面，不能将此规则宣称为防御恶意 Owner。
DEFINE FUNCTION OVERWRITE fn::signal_member_active($member: record<user>) {
  RETURN array::len(
    SELECT VALUE id
    FROM user
    WHERE
      id = $member
      AND kind = 'human'
      AND disabled_at = NONE
  ) = 1;
};
DEFINE FUNCTION OVERWRITE fn::signal_sdp($raw: string, $kind: string) {
  LET $sdp = encoding::json::decode($raw);
  RETURN type::is_object($sdp)
  AND array::len(object::keys($sdp)) = 2
  AND $sdp.type = $kind
  AND type::is_string($sdp.sdp)
  AND string::starts_with($sdp.sdp, 'v=0\r\n')
  AND string::contains($sdp.sdp, '\r\nm=')
  AND string::contains($sdp.sdp, '\r\na=fingerprint:sha-256 ')
  AND string::contains($sdp.sdp, '\r\na=ice-ufrag:')
  AND string::contains($sdp.sdp, '\r\na=ice-pwd:');
};
DEFINE TABLE OVERWRITE native_signal_rate SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE sender ON native_signal_rate TYPE record<user>;
DEFINE FIELD OVERWRITE sent_at ON native_signal_rate TYPE datetime;
DEFINE INDEX OVERWRITE native_signal_rate_sender ON native_signal_rate FIELDS sender
  UNIQUE;

DEFINE TABLE OVERWRITE native_signal SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      $auth != NONE
      AND (
        $auth.id = sender
        OR $auth.id = recipient
      )
      AND fn::signal_member_active(sender)
      AND fn::signal_member_active(recipient)
      AND expires_at > time::now()
    FOR create WHERE
      $auth != NONE
      AND $auth.id = sender
      AND fn::signal_member_active(sender)
      AND fn::signal_member_active(recipient)
    FOR update WHERE
      $auth != NONE
      AND (
        $auth.id = sender
        OR $auth.id = recipient
      )
      AND fn::signal_member_active(sender)
      AND fn::signal_member_active(recipient)
      AND expires_at > time::now()
    FOR delete NONE;
DEFINE FIELD OVERWRITE workspace ON native_signal TYPE string;
DEFINE FIELD OVERWRITE sender ON native_signal TYPE record<user>;
DEFINE FIELD OVERWRITE recipient ON native_signal TYPE record<user>;
DEFINE FIELD OVERWRITE nonce ON native_signal TYPE string
  ASSERT string::matches($value, '^[0-9a-f]{64}$');
DEFINE FIELD OVERWRITE generation ON native_signal TYPE string
  ASSERT string::matches($value, '^[0-9a-f]{64}$');
DEFINE FIELD OVERWRITE offer ON native_signal TYPE string
  ASSERT string::len($value) <= 49152
  AND string::matches($value, '^[\\x00-\\x7f]*$');
DEFINE FIELD OVERWRITE offer_hash ON native_signal TYPE string;
DEFINE FIELD OVERWRITE answer ON native_signal TYPE option<string>
  ASSERT $value = NONE
  OR (
    string::len($value) <= 49152 AND string::matches($value, '^[\\x00-\\x7f]*$')
  );
DEFINE FIELD OVERWRITE status ON native_signal TYPE 'pending' | 'accepted' | 'answered' | 'rejected' | 'ended';
DEFINE FIELD OVERWRITE created_at ON native_signal TYPE datetime
  VALUE IF $before = NONE {
    time::now();
  } ELSE {
    $before;
  };
DEFINE FIELD OVERWRITE expires_at ON native_signal TYPE datetime
  VALUE IF $before = NONE {
    time::now() + 120s;
  } ELSE {
    $before;
  };
DEFINE INDEX OVERWRITE native_signal_nonce ON native_signal FIELDS sender, nonce
  UNIQUE;
DEFINE INDEX OVERWRITE native_signal_generation ON native_signal FIELDS sender, generation
  UNIQUE;

-- 事件与原始写入同事务。逐sender唯一行使并发邀请产生写冲突而非双放行。
DEFINE EVENT OVERWRITE native_signal_guard ON native_signal
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    IF $auth = NONE
    OR $after.workspace != session::db()
    OR $after.sender = $after.recipient
    OR !fn::signal_member_active($after.sender)
    OR !fn::signal_member_active($after.recipient) {
      THROW 'signal: identity';
    };
    IF $event = 'CREATE' {
      IF !string::matches(<string> record::id($after.id), '^[0-9a-f]{64}$')
      OR $auth.id != $after.sender
      OR $after.status != 'pending'
      OR $after.answer != NONE
      OR $after.offer_hash != crypto::sha256($after.offer)
      OR !fn::signal_sdp($after.offer, 'offer') {
        THROW 'signal: invalid invitation';
      };
      LET $rate = type::record('native_signal_rate', <string> $after.sender);
      LET $last = SELECT * FROM ONLY $rate;
      IF $last != NONE
      AND $last.sent_at + 10s > time::now() {
        THROW 'signal: rate limit';
      };
      UPSERT $rate SET sender = $after.sender, sent_at = time::now();
    } ELSE {
      IF $before.workspace != $after.workspace
      OR $before.sender != $after.sender
      OR $before.recipient != $after.recipient
      OR $before.nonce != $after.nonce
      OR $before.generation != $after.generation
      OR $before.offer != $after.offer
      OR $before.offer_hash != $after.offer_hash
      OR $before.created_at != $after.created_at
      OR $before.expires_at != $after.expires_at
      OR $before.expires_at <= time::now() {
        THROW 'signal: immutable binding';
      };
      IF $after.status = 'ended'
      AND $before.status IN ['pending', 'accepted', 'answered']
      AND $after.answer = $before.answer {
        RETURN NONE;
      };
      IF $auth.id != $before.recipient {
        THROW 'signal: recipient only';
      };
      IF $before.status = 'pending'
      AND $after.status IN ['accepted', 'rejected']
      AND $after.answer = NONE {
        RETURN NONE;
      };
      IF $before.status = 'accepted'
      AND $after.status = 'answered'
      AND $before.answer = NONE
      AND $after.answer != NONE
      AND fn::signal_sdp($after.answer, 'answer') {
        RETURN NONE;
      };
      THROW 'signal: invalid transition';
    };
  };
