Status: ready-for-agent
Label: ready-for-agent

# OIP-03 — 模板内跨数据表引用

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

允许模板包中的字段通过目标数据表稳定 key 声明引用。实例化器在事务开始前解析所有目标，生成指向本次新建实体表的真实引用字段；编辑器把它当作普通引用字段使用，不保留模板内部 key 作为运行时目标。

## Acceptance criteria

- [ ] 模板字段可以引用同一模板包内另一个数据表的稳定 key。
- [ ] 实例化后的字段目标是本工作簿中新建的真实实体表，不会串到其他工作簿实例。
- [ ] 引用选择器能够读取目标表记录并写入正确的 RecordId 类型。
- [ ] 引用目标不存在、重复或形成无法解析的声明时，在执行 DDL 前给出中文错误且不产生数据。
- [ ] 两次从同一模板创建的工作簿拥有完全隔离的引用目标。
- [ ] 测试覆盖正常引用、无效目标和两个模板实例的隔离。

## Blocked by

- `.scratch/operating-iteration-plan/issues/02-multi-sheet-template-instantiation.md`
