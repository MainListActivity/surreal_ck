Status: ready-for-agent
Label: ready-for-agent

# OIP-04 — 模板样例数据可选实例化

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

允许模板包为每个数据表携带样例记录。用户创建时可以选择“包含样例数据”或“创建空台账”；包含样例时，实例化器把模板内部的稳定记录 key 和引用转换成本次工作簿的真实 RecordId，并与结构创建放在同一事务中。

## Acceptance criteria

- [ ] 模板创建入口明确提供是否包含样例数据的选择，默认值适合演示场景且可修改。
- [ ] 选择包含样例时，各数据表获得模板声明的记录，跨表引用指向同一实例内记录。
- [ ] 选择不包含样例时只创建结构，不写入任何业务记录。
- [ ] 样例数据类型不符合字段定义或引用无法解析时整体回滚并显示中文错误。
- [ ] 同一模板多次实例化不会共享样例 RecordId。
- [ ] 测试覆盖有样例、无样例、跨表引用和失败回滚。

## Blocked by

- `.scratch/operating-iteration-plan/issues/03-template-cross-sheet-references.md`
