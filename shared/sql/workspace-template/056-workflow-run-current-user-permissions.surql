-- workflow_run 权限归属统一走 fn::current_user()（同 022-resource-library-current-user.surql 先例）。
--
-- 背景：admin access 是 TYPE JWT，会话的 $auth 为 NONE（只有 $token 可用）；
-- participant / employee 是 TYPE RECORD，$auth 已是 user record。
-- 004 的 PERMISSIONS 用 owner_user = $auth 判断归属：管理员会话恒为 false，
-- CREATE 被表权限静默拒绝、不报错，admin 的 router run 因此不落 workflow_run 行
-- （生产审计：成员 run 有行、管理员 run 无行）。fn::current_user() 对 RECORD 会话
-- 直接返回 $auth.id，对 JWT 会话按 $token.sub 反查 user.subject，两条身份路径归一。

DEFINE TABLE OVERWRITE workflow_run SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE owner_user = fn::current_user() OR fn::current_user().is_admin = true,
    FOR create WHERE owner_user = fn::current_user(),
    FOR update WHERE owner_user = fn::current_user(),
    FOR delete WHERE owner_user = fn::current_user() OR fn::current_user().is_admin = true;
