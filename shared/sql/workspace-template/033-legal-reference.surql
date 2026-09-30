-- Workspace-owned pointer and personal note. Platform body text never enters this table.
-- 归因走 fn::current_user()（009）：admin 是 TYPE JWT 会话 $auth=NONE 靠 $token.sub
-- 反查；participant/employee RECORD 会话直接返回 $auth.id。FOR create 的
-- created_by 校验在 DEFAULT 求值之后执行，显式冒名传参会落空。
DEFINE TABLE IF NOT EXISTS legal_reference SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth != NONE AND created_by = fn::current_user(),
    FOR update, delete WHERE created_by = fn::current_user();
DEFINE FIELD IF NOT EXISTS content_public_id ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS content_version_id ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS title ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS source_url ON legal_reference TYPE string;
DEFINE FIELD IF NOT EXISTS published_on ON legal_reference TYPE option<string>;
DEFINE FIELD IF NOT EXISTS locator ON legal_reference TYPE option<string>;
DEFINE FIELD IF NOT EXISTS note ON legal_reference TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 4000;
DEFINE FIELD IF NOT EXISTS created_by ON legal_reference TYPE record<user>
  DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON legal_reference TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS legal_reference_version ON legal_reference FIELDS content_version_id;
