Status: ready-for-agent
Label: ready-for-agent

# OIP-12 — 导入到模板数据表的字段映射与拒绝报告

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

让用户把 CSV 导入现有模板工作簿的数据表。映射器依次使用字段名、模板列别名和宽松文本匹配自动对位，再按目标字段类型规整数据；无法转换或无法解析引用的记录不写入，并以原文件行号和中文原因形成可重试报告。

## Acceptance criteria

- [ ] 用户可以从现有数据表发起 CSV 导入，不创建新的结构资源。
- [ ] 自动映射优先级为精确字段名、模板列别名、大小写/空白宽松匹配，用户可以覆盖或忽略映射。
- [ ] 数字千分位、金额、常见日期、布尔值和单选选项按目标字段类型规整。
- [ ] 引用字段按目标记录显示值匹配并写入 RecordId；未命中时拒绝该记录且不自动创建目标。
- [ ] 完成后展示成功数及每条拒绝记录的原始行号、字段和中文原因，可仅重试修正后的失败部分。
- [ ] 查询和写入使用浏览器当前会话，查询中不重复添加权限过滤条件。
- [ ] 测试使用破产债权模板别名验证常见历史台账表头自动对位。

## Blocked by

- `.scratch/operating-iteration-plan/issues/01-template-package-single-sheet-compat.md`
- `.scratch/operating-iteration-plan/issues/11-csv-new-workbook-import.md`
