-- fn::current_user() —— 在任意会话身份下解析"当前用户"的 user record id。
--
-- 背景：admin access 是 TYPE JWT，其 AUTHENTICATE 块不 RETURN record，
-- 所以 admin 会话的 $auth 为 NONE（只有 $token 可用）。而创建 workbook 等
-- DDL 操作必须走 admin，于是建表的真人天然落在"无 $auth"路径上。
-- participant / employee 是 TYPE RECORD，$auth 已是 user record。
--
-- 本函数统一两条路径：
--   • RECORD 会话（participant/employee）：$auth 已是 user，直接返回。
--   • JWT 会话（admin）：$auth 为 NONE，按 $token.sub 反查 user.subject。
--   • 都拿不到（如纯 root 维护连接）：返回 NONE。
--
-- 被 004-workflow-run.surql 的 owner_user DEFAULT fn::current_user() 调用。
-- 对函数的引用是惰性的（仅在 CREATE/INSERT 求值），所以本增量晚于 004 加载无碍。

DEFINE FUNCTION OVERWRITE fn::current_user() -> option<record<user>> {
    IF $auth != NONE {
        RETURN $auth.id;
    };
    IF $token != NONE AND $token.sub != NONE {
        RETURN (SELECT VALUE id FROM ONLY user WHERE subject = $token.sub LIMIT 1);
    };
    RETURN NONE;
} PERMISSIONS FULL;
