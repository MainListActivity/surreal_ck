Status: done
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

## Comments

- 2026-09-30 CV-01 实施记录（对照既有 OIP 能力）：
  - `key` 唯一、label/description、管理员写/成员只读：`011-workbook-template.surql` 已覆盖（OIP-01）。
  - 数据表定义数组与每列别名：`012` `sheet_defs` 已覆盖；顶层 `column_defs` 保留为旧模板兼容输入（OIP-01）。
  - 模板内跨表引用声明：`013` `reference_sheet_key` 已覆盖（OIP-03）。
  - 可选样例记录：`014` `sample_records` 已覆盖（OIP-04）。
  - 可选 agent 领域提示对象：`018` `row_analysis` 已覆盖（OIP-17）。
  - 共享 DTO `shared/src/dto/workbook-template.ts` 与 schema 同口径（storedDef snake_case），无第二套列描述语言。
  - 缺口与本次新增：既有权限集成测试依赖 `RUN_LOCAL_SURREALDB_TESTS`（CI 不跑）。新增 `server/src/db/workbook-template-contract.integration.test.ts`：spawn 内存 SurrealDB、应用 001-034 全量链并整体重放验证幂等，验证包行全字段（别名/引用/样例/领域提示）与旧 `column_defs` 行的成员可读、成员写/删/DDL 被拒、管理员会话增改删、`key` 唯一索引、SCHEMAFULL 拒未声明顶层字段。无新增 schema 增量（现有契约已覆盖全部验收标准），不改写/删除既有数据。
  - 交接：模板包数据行与播种接线属 CV-02；多表实例化属 CV-03。
