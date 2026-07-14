-- 通用模板包信封。OIP-01 只实例化 sheet_defs 的第一项；
-- 后续增量会在同一形状上扩展多数据表和跨表引用。
--
-- 保留 011 的顶层 column_defs，作为旧模板记录的兼容输入。不在迁移时
-- 回填或删除它，避免改写用户已维护的模板数据。
--
-- aliases 是历史 Excel / CSV 列名；它只用于导入匹配，不会成为真实数据表字段。

DEFINE FIELD IF NOT EXISTS sheet_defs ON TABLE workbook_template TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS sheet_defs.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.key ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.label ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 80;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.column_defs ON TABLE workbook_template TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS sheet_defs.*.column_defs.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.column_defs.*.aliases ON TABLE workbook_template TYPE option<array<string>>;
