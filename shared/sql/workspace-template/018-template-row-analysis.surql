-- OIP-17：模板可为通用行分析 agent 提供领域背景、字段语义、检查重点和输出要求。
-- 平台 prompt 不保存行业知识；空值表示继续使用通用行分析。

DEFINE FIELD IF NOT EXISTS row_analysis ON TABLE workbook_template TYPE option<object>;
DEFINE FIELD IF NOT EXISTS row_analysis.background ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 4000;
DEFINE FIELD IF NOT EXISTS row_analysis.field_semantics ON TABLE workbook_template TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS row_analysis.field_semantics.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS row_analysis.field_semantics.*.field_key ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS row_analysis.field_semantics.*.meaning ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 1000;
DEFINE FIELD IF NOT EXISTS row_analysis.review_points ON TABLE workbook_template TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS row_analysis.review_points.* ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 1000;
DEFINE FIELD IF NOT EXISTS row_analysis.output_guidance ON TABLE workbook_template TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS row_analysis.output_guidance.* ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 1000;

