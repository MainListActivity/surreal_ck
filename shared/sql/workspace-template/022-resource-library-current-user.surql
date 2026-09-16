-- 资源库身份归因统一走 fn::current_user()。
-- admin access 是 TYPE JWT，$auth 为 NONE；participant / employee 的 $auth 是 user record。
-- 直接使用 $auth 会使管理员创建 research_session / resource_item 时无法写入 record<user>。

DEFINE TABLE OVERWRITE research_session SCHEMAFULL
  PERMISSIONS
    FOR select WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true,
    FOR create WHERE fn::current_user() != NONE,
    FOR update, delete WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true;
DEFINE FIELD OVERWRITE created_by ON TABLE research_session TYPE record<user> DEFAULT fn::current_user();

DEFINE TABLE OVERWRITE resource_item SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create, update WHERE fn::current_user() != NONE,
    FOR delete WHERE fn::current_user().is_admin = true;
DEFINE FIELD OVERWRITE created_by ON TABLE resource_item TYPE record<user> DEFAULT fn::current_user();

DEFINE TABLE OVERWRITE resource_embedding SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create, update WHERE fn::current_user() != NONE,
    FOR delete WHERE fn::current_user().is_admin = true;

DEFINE TABLE OVERWRITE workspace_embedding_profile SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create, update, delete WHERE fn::current_user().is_admin = true;
