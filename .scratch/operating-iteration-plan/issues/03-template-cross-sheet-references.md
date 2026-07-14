Status: done
Label: done

# OIP-03 — 模板内跨数据表引用

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

允许模板包中的字段通过目标数据表稳定 key 声明引用。实例化器在事务开始前解析所有目标，生成指向本次新建实体表的真实引用字段；编辑器把它当作普通引用字段使用，不保留模板内部 key 作为运行时目标。

## Acceptance criteria

- [x] 模板字段可以引用同一模板包内另一个数据表的稳定 key。
- [x] 实例化后的字段目标是本工作簿中新建的真实实体表，不会串到其他工作簿实例。
- [x] 引用选择器能够读取目标表记录并写入正确的 RecordId 类型。
- [x] 引用目标不存在、重复或形成无法解析的声明时，在执行 DDL 前给出中文错误且不产生数据。
- [x] 两次从同一模板创建的工作簿拥有完全隔离的引用目标。
- [x] 测试覆盖正常引用、无效目标和两个模板实例的隔离。

## Delivered

- 模板字段以 `reference_sheet_key` 声明同包目标；workspace 模板增量 013 正式约束该字段。
- 实例化器先预生成全部 sheet / 实体表标识，再解析引用并在同一事务中写入真实 `reference_table` 与 `reference_sheet_id`。
- 缺失目标、重复数据表 key 和非引用字段携带目标声明都会在发出任何查询前返回中文错误。
- 编辑器公共接口集成测试覆盖候选读取、RecordId 写入和两个模板实例的引用隔离。

## Blocked by

- `.scratch/operating-iteration-plan/issues/02-multi-sheet-template-instantiation.md`
