-- VO01 验收修复：结构化 answer 与文字 resolution 同属终态。
-- 031 的 user_notification_resolution_guard 只守住 resolved_at / resolution，
-- 收件人首次解决后仍能 UPDATE answer 改口。OVERWRITE 同一事件把 answer 纳入
-- 终态守卫：一旦落库即冻结，重复提交同值天然幂等，改写/清空一律 THROW 回滚。
DEFINE EVENT OVERWRITE user_notification_resolution_guard ON TABLE user_notification
  WHEN $event = "UPDATE"
  THEN {
    IF $before.resolved_at != NONE AND $after.resolved_at != $before.resolved_at {
      THROW "user_notification: resolution is terminal";
    };
    IF $before.resolution != NONE AND $after.resolution != $before.resolution {
      THROW "user_notification: resolution is terminal";
    };
    IF $before.answer != NONE AND $after.answer != $before.answer {
      THROW "user_notification: resolution is terminal";
    };
  };
