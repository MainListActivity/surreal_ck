-- 体检规则对象要能落下解析器接受的字段。仅有 FLEXIBLE 时，当前引擎仍拒绝未声明的键。

DEFINE FIELD IF NOT EXISTS check_rules.rules.*.key ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.type ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.sheet_key ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.fields ON TABLE workbook_template TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.minimum_group_size ON TABLE workbook_template TYPE option<int>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.explanation ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.field ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.target_sheet_key ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.left_field ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS check_rules.rules.*.right_field ON TABLE workbook_template TYPE option<string>;
