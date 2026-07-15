-- OIP-05：模板包可声明一个默认仪表盘页面。widget 沿用 dashboard_page.widgets
-- 的 DashboardWidget 结构；spec 中的 baseTable / sourceTables 在模板记录里保存
-- 数据表稳定 key，实例化时再映射成本工作簿的真实实体表名。

DEFINE FIELD IF NOT EXISTS default_dashboard ON TABLE workbook_template TYPE option<object>;
DEFINE FIELD IF NOT EXISTS default_dashboard.title ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 120;
DEFINE FIELD IF NOT EXISTS default_dashboard.slug ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 120;
DEFINE FIELD IF NOT EXISTS default_dashboard.description ON TABLE workbook_template TYPE option<string>;
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets ON TABLE workbook_template TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.* ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.*.id ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 120;
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.*.title ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 120;
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.*.viewType ON TABLE workbook_template TYPE string
  ASSERT $value IN ["kpi", "table", "bar", "line", "pie", "area"];
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.*.spec ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.*.grid ON TABLE workbook_template TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS default_dashboard.widgets.*.display ON TABLE workbook_template TYPE option<object> FLEXIBLE;
