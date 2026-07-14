Status: done
Label: done

# OIP-01 — 模板包单数据表兼容切片

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

把现有只含 `column_defs` 的模板记录升级为通用“模板包”信封，但本切片只实例化一个数据表。已有内置模板和空白工作簿行为必须保持不变；新增模板可以在数据中声明数据表 key、名称、字段和 Excel 列别名，前端无需认识任何行业名称即可展示并创建。

这是通用模板引擎的兼容起点，不在本切片处理多数据表、引用、样例数据或仪表盘。

## Acceptance criteria

- [x] 模板包 schema 能表达一个数据表的稳定 key、展示名、字段定义和字段列别名。
- [x] 旧 `column_defs` 模板仍能展示并创建出与当前一致的单数据表工作簿。
- [x] 新形状的单数据表模板能从模板页创建并进入编辑器，字段类型与模板数据一致。
- [x] 空白工作簿仍没有模板引用，创建行为不受影响。
- [x] 模板数据全员可读、仅工作区管理员可增改删，权限由 SurrealDB schema 执行。
- [x] 测试覆盖旧记录兼容、新记录创建及普通成员无法执行结构创建。

## Delivered

- 新增 workspace schema v12，以 `sheet_defs` 表达模板包数据表的稳定 key、展示名、字段与 Excel / CSV 列别名，不改写旧 `column_defs`。
- 模板 store 将新包规范化为共享类型；实例化时优先使用首个 `sheet_defs`，旧模板继续回退顶层列定义。
- 模板页把首个数据表的展示名和字段交给现有原子创建事务，空白工作簿仍不带模板引用。
- 真实 SurrealDB 3.0.5 集成测试验证普通成员可读新旧模板，但无法写模板或执行 DDL。

## Blocked by

None - can start immediately
