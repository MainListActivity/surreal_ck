-- OIP-09：模板可声明 AI 快捷任务；实例化后的数据表保留模板内稳定 key，
-- 因而数据表改名后仍能正确筛选适用任务。

DEFINE FIELD IF NOT EXISTS quick_tasks ON TABLE workbook_template TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS quick_tasks.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS quick_tasks.*.key ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS quick_tasks.*.label ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 80;
DEFINE FIELD IF NOT EXISTS quick_tasks.*.task_text ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 1000;
DEFINE FIELD IF NOT EXISTS quick_tasks.*.sheet_keys ON TABLE workbook_template TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS quick_tasks.*.sheet_keys.* ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS quick_tasks.*.risk ON TABLE workbook_template TYPE string
  ASSERT $value IN ["query", "write", "ddl"];

DEFINE FIELD IF NOT EXISTS template_sheet_key ON TABLE sheet TYPE option<string>
  ASSERT $value = NONE OR (string::len($value) > 0 AND string::len($value) <= 64);
