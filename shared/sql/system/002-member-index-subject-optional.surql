-- 预创建成员尚无 OIDC subject：把 user_workspace_index.subject 改为 option<string>，
-- 写 NONE 占位。SurrealDB 中 NONE 值不参与唯一索引约束，因此多个待绑定成员
-- 可在同一 workspace 共存，唯一索引 (subject, workspace) 不冲突；首次登录时由
-- switch-workspace 按 email 回填 subject。
DEFINE FIELD OVERWRITE subject ON TABLE user_workspace_index TYPE option<string>;
