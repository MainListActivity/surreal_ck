-- 返工 R4：漏斗埋点修复（任务 38ccb7d6；运营验收 9df89f64 退回，口径依据 scope 提案 P1-1）。
--
-- 只重定义已有定义：funnel_event 的 PERMISSIONS，以及 user / chat_write_fence 上的两个事件。
-- 不改写、不删除任何已有 funnel_event 行（含生产 2026-10-29 的 first_login 行，清理由经理决定）。
-- 040 / 041 / 059 保持原样；本迁移用 OVERWRITE 重定义，可重复执行。
--
-- 1. 写入收紧：普通登录会话（participant 等 RECORD 会话）不能直接 CREATE funnel_event。
--    事件体（DEFINE EVENT）以定义者身份写入，不受表 PERMISSIONS 约束，触发写入不受影响。
--    select / update / delete 口径与 059 相同。
-- 2. first_login 只在真实首次进入工作区时计数，不再由「添加成员」触发：
--    - member-manager.ts 的 addMember 只 INSERT human user，subject 留 NONE：CREATE 条件要求 subject 已有值，不计；
--    - 首次登录绑定（workspace-scope.ts 的 Scenario B：UPDATE … SET subject，subject 由 NONE 或空串变为有值）计一次；
--    - 认证首次创建的真人行（001-access.surql / 007-access-claim-rename.surql 的 IF !$existing 分支，或工作区创建者引导）
--      带 subject 创建，计一次。
--    同一 user 行的 subject 只会从 NONE 变为有值一次；成员移除是软删（disabled_at），重新加入复用同一行（email 唯一），
--    因此每个成员每个工作区至多计一次。
-- 3. ai_proposal_adopted 只计「pending → consumed + write-confirmed」这一次首次确认。
--    resume 失败时 releaseSuspendDecision 把 resumed 回滚为 consumed（写已落库，consumed_by 仍是 write-confirmed），
--    059 的边沿条件会把这次回滚误计为第二次确认。
--
-- day 为 UTC 日（time::now() 的 %Y-%m-%d），与活动类功能的浏览器本地日口径差异待经理决定，本迁移不改。
-- 访问事件不在本迁移范围（待老板确认）。

DEFINE TABLE OVERWRITE funnel_event SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create NONE,
    FOR update, delete WHERE $auth.is_admin = true;

DEFINE EVENT OVERWRITE user_first_login_funnel ON TABLE user
  WHEN $after.kind = "human"
    AND $after.subject != NONE
    AND $after.subject != ""
    AND (
      $event = "CREATE"
      OR ($event = "UPDATE" AND ($before.subject = NONE OR $before.subject = ""))
    )
  THEN {
    CREATE funnel_event CONTENT {
      event: "first_login",
      day: time::format(time::now(), "%Y-%m-%d"),
    };
  };

DEFINE EVENT OVERWRITE chat_write_fence_funnel ON TABLE chat_write_fence
  WHEN $event = "UPDATE"
    AND $before.status = "pending"
    AND $after.status = "consumed"
    AND $after.consumed_by = "write-confirmed"
  THEN {
    CREATE funnel_event CONTENT {
      event: "ai_proposal_adopted",
      day: time::format(time::now(), "%Y-%m-%d"),
    };
  };
