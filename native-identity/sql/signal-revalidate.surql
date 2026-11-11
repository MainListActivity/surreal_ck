-- 与邀请生命周期独立的固定只读检查；必须同时返回当前 subject 对应成员和指定对端。
SELECT type::string(id) AS id
FROM user
WHERE
  kind = 'human'
  AND disabled_at = NONE
  AND (
    (
      id = $auth.id
      AND subject = $subject
    )
    OR id = type::record('user', $peer)
  );
