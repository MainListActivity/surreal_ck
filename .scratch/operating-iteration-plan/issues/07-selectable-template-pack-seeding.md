Status: done
Label: done

# OIP-07 — 可选择的模板包数据播种

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

建立模板包数据文件的发现与播种约定，使部署配置能够选择要安装到新 workspace 的模板包，同时允许已有 workspace 由管理员执行同一份幂等 SurQL 数据文件完成安装或升级。平台生命周期只负责选择和执行文件，不认识模板的行业语义。

## Acceptance criteria

- [x] 模板包内容以独立数据文件存在，与平台通用 schema 迁移分离。
- [x] 部署配置为空时不播种任何垂直模板，空白工作簿及通用功能仍可使用。
- [x] 选择模板包后，新 workspace 创建完成即可在模板页看到它。
- [x] 同一数据文件可由管理员在已有 workspace 幂等执行，不产生重复 key 或覆盖未声明字段。
- [x] 未知模板包、文件解析失败或执行失败时 workspace 创建按现有 lifecycle 补偿，不留下不完整 workspace。
- [x] 增加一个测试模板包只新增数据文件和测试 fixture，不修改平台业务代码。

## Delivered

- 新增 `shared/sql/template-packs/<name>.surql` 数据文件约定与自动加载器；配置顺序即执行顺序，未知包和非法包名给出明确错误。
- `WORKSPACE_TEMPLATE_PACKS` 支持逗号分隔、去空白和去重；空配置不读取或执行任何模板包。
- workspace 创建在通用 schema 后执行所选数据包，加载、解析或执行失败沿用现有 database 删除补偿，且不会写 `_system` 或换发 IdP scope。
- 原五个法律入门模板从 011 schema migration 移入可选 `legal-starter.surql`；重复执行仅更新声明字段，不覆盖管理员扩展的 `column_defs`。
- 临时内存 SurrealDB 集成测试验证普通成员权限，以及工作区管理员在已有 workspace 重复安装时 key 不重复、自定义字段保持不变。

## Blocked by

- `.scratch/operating-iteration-plan/issues/05-template-default-dashboard.md`
- `.scratch/operating-iteration-plan/issues/06-workspace-migration-auto-discovery.md`
