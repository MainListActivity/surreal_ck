-- OIP-03：模板字段可通过同一模板包内的数据表稳定 key 声明引用目标。
-- 该 key 只参与实例化前解析；真实 sheet.column_defs 保存实体表名与 sheet RecordId。

DEFINE FIELD IF NOT EXISTS sheet_defs.*.column_defs.*.reference_sheet_key ON TABLE workbook_template TYPE option<string>
  ASSERT $value = NONE OR ($value != "" AND string::len($value) <= 64);
