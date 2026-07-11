Status: ready-for-agent
Label: ready-for-agent

# OIP-16 — 资源与业务记录关联

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

在现有资源保存、向量检索和 citation 能力上补齐业务记录关联。用户可以从资源面板把网页资源或手工摘要关联到当前选中记录；行分析时以当前记录为范围读取关联资源，并在回答中复用现有结构化 citation 展示来源。

只有关联本身需要独立生命周期和双向遍历，因此用带创建者与时间的业务关系表达，不把 workspace 隔离条件重复写进查询。

## Acceptance criteria

- [ ] 用户可以保存网页资源或手工摘要，并关联到当前数据表的一条记录。
- [ ] 同一资源可以关联多条记录，同一记录可以查看全部关联资源。
- [ ] 关联写入使用当前用户 workspace session，创建者归因来自 `$auth` 而非手工字段。
- [ ] 行分析能优先使用当前记录的关联资源，并在回答中展示可点击 citation。
- [ ] 删除关联不会删除资源本身；删除资源后的失效关联有明确清理或忽略策略。
- [ ] 测试覆盖双向遍历、权限、解除关联及无关联资源时的通用回退。

## Blocked by

- `.scratch/operating-iteration-plan/issues/08-bankruptcy-claims-template-pack.md`
