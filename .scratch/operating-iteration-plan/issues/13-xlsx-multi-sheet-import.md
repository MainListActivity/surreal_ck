Status: ready-for-agent
Label: ready-for-agent

# OIP-13 — XLSX 多 Sheet 导入闭环

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

在 CSV 闭环上增加 `.xlsx` 解析和 Sheet 选择。用户可以把一个 Excel 文件中的多个 Sheet 导入为新工作簿的多个数据表，或逐个映射到已有模板工作簿的数据表；每个 Sheet 独立预览和校验，最终给出汇总及逐 Sheet 结果。

## Acceptance criteria

- [ ] 支持 `.xlsx` 文件并列出所有可见 Sheet、表头和至少前 20 行预览。
- [ ] 用户可选择忽略某些 Sheet，并为保留的 Sheet 选择“新建数据表”或“映射已有数据表”。
- [ ] 新工作簿多数据表创建遵循模板实例化相同的原子结构创建边界。
- [ ] 已有模板数据表复用字段别名、类型规整、引用解析和拒绝报告。
- [ ] 完成页展示总成功/跳过数及每个 Sheet 的独立结果，失败信息不暴露底层堆栈。
- [ ] 大文件解析不会冻结主界面，用户可取消尚未确认的导入。
- [ ] 测试覆盖中文 Sheet 名、Excel 日期、空 Sheet、重复表头及部分 Sheet 失败。

## Blocked by

- `.scratch/operating-iteration-plan/issues/02-multi-sheet-template-instantiation.md`
- `.scratch/operating-iteration-plan/issues/12-template-sheet-import-mapping.md`
