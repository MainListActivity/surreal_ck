-- 导入批次安全撤销：保留创建时版本戳与不可删除的撤销审计回执。

DEFINE FIELD IF NOT EXISTS target_updated_at ON TABLE import_batch_row TYPE option<datetime>;

DEFINE FIELD OVERWRITE status ON TABLE import_batch TYPE string
  ASSERT $value INSIDE ["processing", "completed", "partial_failure", "failed", "outcome_unknown", "undone"];

DEFINE TABLE IF NOT EXISTS import_batch_undo SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create WHERE created_by = fn::current_user(),
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS batch ON TABLE import_batch_undo TYPE record<import_batch> READONLY;
DEFINE FIELD IF NOT EXISTS status ON TABLE import_batch_undo TYPE string ASSERT $value = "completed" READONLY;
DEFINE FIELD IF NOT EXISTS deleted_count ON TABLE import_batch_undo TYPE int ASSERT $value >= 0 READONLY;
DEFINE FIELD IF NOT EXISTS target_records ON TABLE import_batch_undo TYPE array<record> READONLY;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE import_batch_undo TYPE record<user> DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE import_batch_undo TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS import_batch_undo_batch_unique ON TABLE import_batch_undo COLUMNS batch UNIQUE;
