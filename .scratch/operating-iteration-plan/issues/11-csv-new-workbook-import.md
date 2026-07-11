Status: ready-for-agent
Label: ready-for-agent

# OIP-11 — CSV 导入新工作簿闭环

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

把首页“导入文件”从 stub 变成第一个可用的 CSV 纵向闭环：用户选择 UTF-8 CSV，预览中文表头和前 20 行，确认自动推断的文本、数字、日期及金额字段后，以当前管理员会话创建新工作簿和数据表、写入合法记录并进入编辑器。

## Acceptance criteria

- [ ] 首页导入入口接受 `.csv`，支持中文文件名、中文表头和常见带 BOM 文件。
- [ ] 导入前展示表头、至少前 20 行及推断字段类型，用户可修改字段名和类型。
- [ ] 确认后以单次可回滚流程创建新工作簿、实体表、数据表元数据并写入记录。
- [ ] 完成页展示成功记录数、跳过记录数和字段识别结果，然后可进入新数据表。
- [ ] 普通成员触发新工作簿 DDL 时显示管理员权限提示，不绕过数据库 access。
- [ ] 解析和类型推断是无 UI 依赖的纯逻辑，并有中文表头、金额、日期和空值测试。

## Blocked by

None - can start immediately
