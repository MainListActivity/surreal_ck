Status: ready-for-agent
Label: ready-for-agent

# OIP-01 — 模板包单数据表兼容切片

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

把现有只含 `column_defs` 的模板记录升级为通用“模板包”信封，但本切片只实例化一个数据表。已有内置模板和空白工作簿行为必须保持不变；新增模板可以在数据中声明数据表 key、名称、字段和 Excel 列别名，前端无需认识任何行业名称即可展示并创建。

这是通用模板引擎的兼容起点，不在本切片处理多数据表、引用、样例数据或仪表盘。

## Acceptance criteria

- [ ] 模板包 schema 能表达一个数据表的稳定 key、展示名、字段定义和字段列别名。
- [ ] 旧 `column_defs` 模板仍能展示并创建出与当前一致的单数据表工作簿。
- [ ] 新形状的单数据表模板能从模板页创建并进入编辑器，字段类型与模板数据一致。
- [ ] 空白工作簿仍没有模板引用，创建行为不受影响。
- [ ] 模板数据全员可读、仅工作区管理员可增改删，权限由 SurrealDB schema 执行。
- [ ] 测试覆盖旧记录兼容、新记录创建及普通成员无法执行结构创建。

## Blocked by

None - can start immediately
