Status: ready-for-agent
Label: ready-for-agent

# OIP-14 — 历史债权台账导入后看板就绪

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

补齐销售演示中的组合路径：用户从破产债权模板创建空台账，导入历史 Excel 后直接看到默认仪表盘基于新数据刷新。导入流程要引导用户选择正确的模板数据表，并在完成时提供“查看数据表”和“查看仪表盘”两个明确出口。

## Acceptance criteria

- [ ] 用户可创建不带样例数据的破产债权工作簿并导入历史 Excel。
- [ ] 至少债权人和债权记录相关 Sheet 能通过列别名完成映射，引用按导入顺序正确建立。
- [ ] 导入完成后默认仪表盘无需重新创建或手工配置即可查询导入数据。
- [ ] KPI、状态分布及待补材料组件与导入成功记录一致，拒绝记录不计入统计。
- [ ] 完成页可以直接打开第一个导入数据表或默认仪表盘。
- [ ] 提供一份脱敏验收 fixture 和可重复执行的端到端手工验收清单。

## Blocked by

- `.scratch/operating-iteration-plan/issues/08-bankruptcy-claims-template-pack.md`
- `.scratch/operating-iteration-plan/issues/13-xlsx-multi-sheet-import.md`
