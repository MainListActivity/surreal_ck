Status: done
Label: done

# OIP-12 — 导入到模板数据表的字段映射与拒绝报告

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

让用户把 CSV 导入现有模板工作簿的数据表。映射器依次使用字段名、模板列别名和宽松文本匹配自动对位，再按目标字段类型规整数据；无法转换或无法解析引用的记录不写入，并以原文件行号和中文原因形成可重试报告。

## Acceptance criteria

- [x] 用户可以从现有数据表发起 CSV 导入，不创建新的结构资源。
- [x] 自动映射优先级为精确字段名、模板列别名、大小写/空白宽松匹配，用户可以覆盖或忽略映射。
- [x] 数字千分位、金额、常见日期、布尔值和单选选项按目标字段类型规整。
- [x] 引用字段按目标记录显示值匹配并写入 RecordId；未命中时拒绝该记录且不自动创建目标。
- [x] 完成后展示成功数及每条拒绝记录的原始行号、字段和中文原因，可仅重试修正后的失败部分。
- [x] 查询和写入使用浏览器当前会话，查询中不重复添加权限过滤条件。
- [x] 测试使用破产债权模板别名验证常见历史台账表头自动对位。

## Blocked by

- `.scratch/operating-iteration-plan/issues/01-template-package-single-sheet-compat.md`
- `.scratch/operating-iteration-plan/issues/11-csv-new-workbook-import.md`

## Comments

- 2026-07-16：按 TDD 完成现有数据表 CSV 导入纵向闭环。编辑器工具栏可打开导入向导；自动映射严格按精确字段名、模板别名、大小写/空白宽松匹配三轮执行，支持用户覆盖或忽略。
- 类型规整覆盖千分位数字、货币金额、常见年月日、中文/英文布尔值和单选项；字段规则失败时整行拒绝，报告保留原文件行号、字段、中文原因和原始单元格。
- 引用字段使用当前浏览器 SurrealDB 会话读取目标显示字段，唯一命中后通过 SDK RecordId 写入；未命中或多义均拒绝且不创建目标。修正后仅重试失败行并保留原行号。
- 验证：根工作区测试通过（Web 432 pass / 15 skip / 0 fail）；全仓 TypeScript 0 errors；Web 生产构建成功；新增引用查询经 SurrealDB 3.0.5 CLI validate 通过。
