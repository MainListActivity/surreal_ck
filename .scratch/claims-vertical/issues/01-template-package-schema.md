Status: ready-for-agent
Label: ready-for-agent

# CV-01 — 模板包通用 schema 与权限

## Parent

`.scratch/claims-vertical/PRD.md`

## What to build

在 workspace database 中完善 `workbook_template` 数据契约：唯一 `key`、展示名、描述、数据表定义数组、每列别名与模板内引用声明、可选样例记录、可选 agent 领域提示。列定义沿用 `sheet.column_defs` 的 storedDef（snake_case）形状。成员可读，只有管理员可增改删；跨 workspace 隔离由 database 边界承担。

先对照现有 `shared/sql/workspace-template/011`、`012`、`013`、`014` 及后续增量和 OIP-01/03/04/17：已有 `sheet_defs`、样例及 `row_analysis` 时只补缺口，保持旧单表模板兼容，不重复定义表或改写现有模板记录。新增通用 schema 只能走带版本号的 workspace-template 增量。

## Acceptance criteria

- [ ] 模板行可表达 PRD 要求的字段、跨表引用、列别名、样例和领域提示；旧顶层 `column_defs` 模板仍可读取。
- [ ] `key` 唯一，管理员可写、普通成员只读；以真实 SurrealDB 验证权限和增量幂等。
- [ ] schema 与共享 DTO 口径一致，不出现第二套列描述语言；不触碰既有生产数据的改写或删除。
- [ ] 新增行为先有失败测试，再做最小实现；覆盖可观察的读取、权限和旧数据兼容。
- [ ] 最高约束：仓库代码、平台 schema、平台 prompt 不得出现法律领域词汇；法律内容必须能经不 seed／删除模板行整体移除。

## Scope handoff

本票只负责平台通用数据契约及权限。具体垂直模板行和 seed 接线交 CV-02；实例化交 CV-03。验收时记录现有 OIP 能力覆盖了哪些标准，未覆盖才新增实现。

## Blocked by

None - can start immediately
