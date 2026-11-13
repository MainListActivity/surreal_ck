-- subject 只取数据库已验签票据的 $token.sub，不接受客户端参数：
-- fork 的 JSON-RPC 会把 UUID 形状的字符串参数（生产 IdP 的 sub）转成 uuid，与字符串 subject 永不相等。
-- 返回 subject 供客户端与本地 Session 精确比对。
SELECT string::concat('user:', type::string(record::id(id))) AS id, subject
FROM user
WHERE
  id = $auth.id
  AND subject = $token.sub
  AND kind = 'human'
  AND disabled_at = NONE
LIMIT 1;
