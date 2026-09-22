-- 可恢复导入批次。源文件全文不落库；只保存摘要、映射版本、逐表状态与逐行回执。
-- 业务记录仍写入动态实体表，成功记录引用由同一事务写入 import_batch_row。

DEFINE TABLE IF NOT EXISTS import_batch SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create WHERE fn::current_user() != NONE,
    FOR update WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE import_batch TYPE option<record<workbook>>;
DEFINE FIELD IF NOT EXISTS file_name ON TABLE import_batch TYPE string ASSERT string::len($value) <= 255;
DEFINE FIELD IF NOT EXISTS file_digest ON TABLE import_batch TYPE string ASSERT string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS mapping_version ON TABLE import_batch TYPE string ASSERT string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS mode ON TABLE import_batch TYPE string
  ASSERT $value INSIDE ["new_workbook", "existing_tables", "mixed"];
DEFINE FIELD IF NOT EXISTS status ON TABLE import_batch TYPE string
  ASSERT $value INSIDE ["processing", "completed", "partial_failure", "failed", "outcome_unknown"];
DEFINE FIELD IF NOT EXISTS created_by ON TABLE import_batch TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE import_batch TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE import_batch TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE import_batch TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS import_batch_digest ON TABLE import_batch COLUMNS file_digest;
DEFINE INDEX IF NOT EXISTS import_batch_created ON TABLE import_batch COLUMNS started_at;

DEFINE TABLE IF NOT EXISTS import_batch_sheet SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create WHERE fn::current_user() != NONE,
    FOR update WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS batch ON TABLE import_batch_sheet TYPE record<import_batch> READONLY;
DEFINE FIELD IF NOT EXISTS sheet_name ON TABLE import_batch_sheet TYPE string ASSERT string::len($value) <= 128 READONLY;
DEFINE FIELD IF NOT EXISTS target_sheet ON TABLE import_batch_sheet TYPE option<record<sheet>>;
DEFINE FIELD IF NOT EXISTS mapping_version ON TABLE import_batch_sheet TYPE string ASSERT string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS mappings ON TABLE import_batch_sheet TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS mappings.* ON TABLE import_batch_sheet TYPE object FLEXIBLE;
-- 定义 array<object> 时 SurrealDB 会先隐式生成非 FLEXIBLE 的子字段；显式 ALTER 才能放行映射属性。
ALTER FIELD mappings.* ON TABLE import_batch_sheet FLEXIBLE;
DEFINE FIELD IF NOT EXISTS status ON TABLE import_batch_sheet TYPE string
  ASSERT $value INSIDE ["pending", "processing", "completed", "failed", "ignored", "outcome_unknown"];
DEFINE FIELD IF NOT EXISTS imported_count ON TABLE import_batch_sheet TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS rejected_count ON TABLE import_batch_sheet TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS error ON TABLE import_batch_sheet TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE import_batch_sheet TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE import_batch_sheet TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE import_batch_sheet TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS import_batch_sheet_unique ON TABLE import_batch_sheet COLUMNS batch, sheet_name UNIQUE;

DEFINE TABLE IF NOT EXISTS import_batch_row SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create WHERE fn::current_user() != NONE,
    FOR update WHERE created_by = fn::current_user() OR fn::current_user().is_admin = true,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS batch ON TABLE import_batch_row TYPE record<import_batch> READONLY;
DEFINE FIELD IF NOT EXISTS sheet_name ON TABLE import_batch_row TYPE string ASSERT string::len($value) <= 128 READONLY;
DEFINE FIELD IF NOT EXISTS source_row_number ON TABLE import_batch_row TYPE int ASSERT $value >= 1 READONLY;
DEFINE FIELD IF NOT EXISTS status ON TABLE import_batch_row TYPE string
  ASSERT $value INSIDE ["success", "rejected", "outcome_unknown"];
DEFINE FIELD IF NOT EXISTS target_record ON TABLE import_batch_row TYPE option<record>;
DEFINE FIELD IF NOT EXISTS field ON TABLE import_batch_row TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reason ON TABLE import_batch_row TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source_cells ON TABLE import_batch_row TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE import_batch_row TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE import_batch_row TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE import_batch_row TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS import_batch_row_source_unique ON TABLE import_batch_row COLUMNS batch, sheet_name, source_row_number UNIQUE;
DEFINE INDEX IF NOT EXISTS import_batch_row_target ON TABLE import_batch_row COLUMNS target_record;
