-- 与邀请生命周期独立的固定只读检查；必须同时返回当前 subject 对应成员和指定对端。
-- subject 取 $token.sub（见 signal-identity.surql）：JSON-RPC 会把 UUID 形状的字符串参数转成 uuid。
SELECT string::concat('user:', type::string(record::id(id))) AS id
FROM user
WHERE
  kind = 'human'
  AND disabled_at = NONE
  AND (
    (
      id = $auth.id
      AND subject = $token.sub
    )
    OR id = type::record('user', $peer)
  );
