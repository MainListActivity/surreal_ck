Status: ready-for-agent
Label: ready-for-agent

# OIP-07 — 可选择的模板包数据播种

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

建立模板包数据文件的发现与播种约定，使部署配置能够选择要安装到新 workspace 的模板包，同时允许已有 workspace 由管理员执行同一份幂等 SurQL 数据文件完成安装或升级。平台生命周期只负责选择和执行文件，不认识模板的行业语义。

## Acceptance criteria

- [ ] 模板包内容以独立数据文件存在，与平台通用 schema 迁移分离。
- [ ] 部署配置为空时不播种任何垂直模板，空白工作簿及通用功能仍可使用。
- [ ] 选择模板包后，新 workspace 创建完成即可在模板页看到它。
- [ ] 同一数据文件可由管理员在已有 workspace 幂等执行，不产生重复 key 或覆盖未声明字段。
- [ ] 未知模板包、文件解析失败或执行失败时 workspace 创建按现有 lifecycle 补偿，不留下不完整 workspace。
- [ ] 增加一个测试模板包只新增数据文件和测试 fixture，不修改平台业务代码。

## Blocked by

- `.scratch/operating-iteration-plan/issues/05-template-default-dashboard.md`
- `.scratch/operating-iteration-plan/issues/06-workspace-migration-auto-discovery.md`
