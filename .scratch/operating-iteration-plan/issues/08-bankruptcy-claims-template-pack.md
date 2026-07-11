Status: ready-for-agent
Label: ready-for-agent

# OIP-08 — 破产债权管理模板包数据交付

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

只通过模板包数据交付“破产债权管理”垂直样板，不增加任何识别“债权”业务的 TypeScript 分支。模板创建后生成债权人、证据材料、待办事项三个数据表，包含真实字段类型、表间引用、5–10 条演示记录及默认债权审核仪表盘。

## Acceptance criteria

- [ ] 本 issue 的产品内容变更仅位于模板包数据和验收 fixture，不修改平台实例化业务代码。
- [ ] 模板创建后生成债权人、证据材料、待办事项三个数据表，字段覆盖父 PRD 的 P0-1 范围。
- [ ] 证据材料和待办事项通过引用字段关联债权人，引用可在编辑器中正常选择和回读。
- [ ] 每个数据表包含 5–10 条类型合法且相互关联的演示记录。
- [ ] 默认仪表盘展示总申报金额、已审核金额、待补材料数、类型/状态分布和未来七天待办中的适用组件。
- [ ] 删除或不播种该模板包后，平台代码、通用模板和空白工作簿仍完整可用。
- [ ] 模板包 SurQL 通过格式化、CLI 校验及实例化手工验收。

## Blocked by

- `.scratch/operating-iteration-plan/issues/07-selectable-template-pack-seeding.md`
