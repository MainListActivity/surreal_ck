-- 模板声明的受限跨记录体检规则。规则内容由前端封闭类型校验，不接受脚本或任意查询。

DEFINE FIELD IF NOT EXISTS check_rules ON TABLE workbook_template TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS check_rules.version ON TABLE workbook_template TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS check_rules.rules ON TABLE workbook_template TYPE array<object> DEFAULT []
  ASSERT array::len($value) <= 100;
DEFINE FIELD IF NOT EXISTS check_rules.rules.* ON TABLE workbook_template TYPE object FLEXIBLE;

DEFINE FIELD OVERWRITE category ON TABLE data_check_finding TYPE string
  ASSERT $value INSIDE [
    "required",
    "format",
    "duplicate_candidate",
    "reference_missing",
    "reference_unverifiable",
    "consistency"
  ];
