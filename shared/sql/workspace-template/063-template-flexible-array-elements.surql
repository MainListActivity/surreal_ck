-- SurrealDB 4 会为 array<object> 自动创建元素字段，原先的 IF NOT EXISTS
-- 无法覆盖自动字段的非 FLEXIBLE 属性。保留已有数据，只修正字段定义。
DEFINE FIELD OVERWRITE sheet_defs.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD OVERWRITE sheet_defs.*.column_defs.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD OVERWRITE sheet_defs.*.sample_records.* ON TABLE workbook_template TYPE object FLEXIBLE;
