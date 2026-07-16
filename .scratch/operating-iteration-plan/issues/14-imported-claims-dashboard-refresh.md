Status: done
Label: done

# OIP-14 — 历史债权台账导入后看板就绪

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

补齐销售演示中的组合路径：用户从破产债权模板创建空台账，导入历史 Excel 后直接看到默认仪表盘基于新数据刷新。导入流程要引导用户选择正确的模板数据表，并在完成时提供“查看数据表”和“查看仪表盘”两个明确出口。

## Acceptance criteria

- [x] 用户可创建不带样例数据的破产债权工作簿并导入历史 Excel。
- [x] 至少债权人和债权记录相关 Sheet 能通过列别名完成映射，引用按导入顺序正确建立。
- [x] 导入完成后默认仪表盘无需重新创建或手工配置即可查询导入数据。
- [x] KPI、状态分布及待补材料组件与导入成功记录一致，拒绝记录不计入统计。
- [x] 完成页可以直接打开第一个导入数据表或默认仪表盘。
- [x] 提供一份脱敏验收 fixture 和可重复执行的端到端手工验收清单。

## Blocked by

- `.scratch/operating-iteration-plan/issues/08-bankruptcy-claims-template-pack.md`
- `.scratch/operating-iteration-plan/issues/13-xlsx-multi-sheet-import.md`

## Delivered

- 模板导入向导按 Excel 表头与模板字段名/列别名计算唯一最高匹配，自动建议目标数据表，用户仍可覆盖。
- 映射到既有模板时按模板数据表顺序执行导入，使债权人等引用目标先于证据材料、待办等引用方落库；逐 Sheet 展示成功与拒绝结果。
- 完成页新增“查看数据表”和“查看仪表盘”出口；打开仪表盘时重跑当前默认页面的真实聚合。
- 新增脱敏 `oip-14-historical-claims.xlsx` fixture 与手工验收清单；fixture 特意把引用方 Sheet 放在债权人 Sheet 之前，并包含金额错误及无效引用两条拒绝记录。
- SurrealDB 3.0.5 集成测试验证空台账导入后成功 6 条、拒绝 2 条，引用正确，默认仪表盘结果为总申报金额 2,000,000、已审核金额 1,500,000、待补材料数 1、两类债权类型、两类审核状态和两条待办。
