-- 实体表成员 DML 权限回填（CV03 返工）：sheet.table_name 是运行时登记的
-- 持久化数据，DDL 标识符不能参数化，按 029/039 先例由服务端迁移执行器
-- 物化出真实 SQL——对已登记且存在的实体表补
--   PERMISSIONS FOR select, create, update, delete
--     WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
-- 带自定义 PERMISSIONS 的表保留原样并告警（不扩大既有授权面）。
RETURN "entity-member-permissions-runtime-materialization-required";
