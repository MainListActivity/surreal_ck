-- OIP-04：每张模板数据表可选携带样例记录。
-- key 仅在模板包内部稳定，用于解析跨表样例引用；values 的字段和值由实例化器
-- 对照 column_defs 校验，并在同一事务中写入新生成的实体表 RecordId。

DEFINE FIELD IF NOT EXISTS sheet_defs.*.sample_records ON TABLE workbook_template TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.sample_records.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.sample_records.*.key ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS sheet_defs.*.sample_records.*.values ON TABLE workbook_template TYPE object FLEXIBLE;
