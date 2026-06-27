-- 工作簿「类型」= 业务模板的产物。
--
-- 底层永不认识「合规 / 案件 / 实体追踪 / 尽调 / 资产」这些业务语义：它们只是
-- workbook_template 表里的数据行。新增一种行业类型 = 插一行数据，零 schema 改动；
-- 用户 / 管理员可改可删内置模板。卡片上的图标 / 强调色 / 类型名全部读模板这条数据，
-- 前端不再用字符串硬猜（替代旧的前端 workbookCardPresentation 推断）。
--
-- workbook.template 指回它由哪个模板生成（option record）：为空就是空白工作簿，
-- 「无类型」是合法常态而非草稿。状态轴（草稿 / 进行中 / 已发布）是另一条正交需求，
-- 本迁移不涉及。
--
-- 归属 workspace database：跨 workspace 隔离靠 db 边界，不带 workspace 字段，
-- PERMISSIONS 只表达本 workspace 内角色——模板全员可见，仅管理员可增改删。

DEFINE TABLE IF NOT EXISTS workbook_template SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete WHERE $auth.is_admin = true;
-- key：稳定业务标识（建模板时定，用于幂等 seed / 引用），全库唯一。
DEFINE FIELD IF NOT EXISTS key ON TABLE workbook_template TYPE string
  ASSERT $value != "" AND string::len($value) <= 64;
DEFINE FIELD IF NOT EXISTS label ON TABLE workbook_template TYPE string;
DEFINE FIELD IF NOT EXISTS description ON TABLE workbook_template TYPE option<string>;
-- icon：lucide 图标名（业务数据，不是底层枚举）；卡片直接据此渲染。
DEFINE FIELD IF NOT EXISTS icon ON TABLE workbook_template TYPE option<string>;
-- accent：卡片强调色（hex）；新行业类型的视觉也由这条业务数据定义。
DEFINE FIELD IF NOT EXISTS accent ON TABLE workbook_template TYPE option<string>;
-- default_name：从模板新建时的默认工作簿名。
DEFINE FIELD IF NOT EXISTS default_name ON TABLE workbook_template TYPE option<string>;
-- column_defs：建实体表的列定义，与 sheet.column_defs 同口径（StoredGridFieldDef[]）。
DEFINE FIELD OVERWRITE column_defs ON TABLE workbook_template TYPE any DEFAULT [];
-- builtin：内置模板标记（seed 播种的）；纯展示用途，不影响权限。
DEFINE FIELD IF NOT EXISTS builtin ON TABLE workbook_template TYPE bool DEFAULT false;
-- sort_order：模板选择页排序。
DEFINE FIELD IF NOT EXISTS sort_order ON TABLE workbook_template TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_template TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workbook_template TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_template_key_unique ON TABLE workbook_template COLUMNS key UNIQUE;
DEFINE INDEX IF NOT EXISTS workbook_template_sort ON TABLE workbook_template COLUMNS sort_order;

-- workbook 升级：旧的游离 template_key(string) → template(record 引用)。
-- 跨 workspace 隔离靠 db 边界，不在 workbook 上加业务过滤；引用为 option，空=空白工作簿。
DEFINE FIELD OVERWRITE template ON TABLE workbook TYPE option<record<workbook_template>>;

-- ---- 内置模板 seed（一次性播种）----
-- migration runner 按版本号增量执行，每个版本只跑一次：用户之后改 / 删内置模板不会被覆盖。
-- ON DUPLICATE KEY UPDATE 仅作同版本重入的防御性幂等。
-- column_defs 为空数组 = 从模板建出的实体表先只有默认 name 列，列结构占位，
-- 后续按 claims-vertical 等垂直簇逐步填充——这里先把「类型」这一层跑通。

INSERT INTO workbook_template [
  { key: "case", label: "案件管理", icon: "scale", accent: "#CC6B3A",
    default_name: "未命名案件库", description: "诉讼 / 破产案件全流程台账",
    builtin: true, sort_order: 10, column_defs: [] },
  { key: "entity", label: "实体追踪", icon: "network", accent: "#3E78A8",
    default_name: "未命名实体库", description: "公司 / 自然人主体及关系网络",
    builtin: true, sort_order: 20, column_defs: [] },
  { key: "compliance", label: "合规", icon: "shield-check", accent: "#2F7A4C",
    default_name: "未命名合规库", description: "合规事项与风险点跟踪",
    builtin: true, sort_order: 30, column_defs: [] },
  { key: "diligence", label: "尽调", icon: "search-check", accent: "#8A5A8F",
    default_name: "未命名尽调库", description: "尽职调查清单与材料归集",
    builtin: true, sort_order: 40, column_defs: [] },
  { key: "asset", label: "资产", icon: "landmark", accent: "#B68A2E",
    default_name: "未命名资产库", description: "资产清册与处置追踪",
    builtin: true, sort_order: 50, column_defs: [] }
]
ON DUPLICATE KEY UPDATE
  label = $input.label,
  icon = $input.icon,
  accent = $input.accent,
  default_name = $input.default_name,
  description = $input.description,
  builtin = $input.builtin,
  sort_order = $input.sort_order;
