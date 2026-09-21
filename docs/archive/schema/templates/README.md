# Schema Templates

> **⚠️ SUPERSEDED（2026-05-20）**：execTemplate / NS-admin 远端建库机制已废除，见
> [`docs/adr/frontend-direct-connect.md`](../../docs/adr/frontend-direct-connect.md) 与
> [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)。
> workspace 创建现在 = 后端 Workspace Scope Module 用 root `DEFINE DATABASE` + 应用
> `shared/sql/workspace-template/` 模板。**不要再据本目录或 execTemplate 开工。**
> 本目录与 `src/main/sync/exec-template.ts` 一并随簇 A 退役 `src/main/**` 时清理；当前仅作历史参考。

以下为历史说明（execTemplate 机制存续时期）：

这些文件是远端 `POST https://auth.maplayer.top/api/db/execTemplate` 的模板源。
模板 id 等于文件名去掉扩展名，例如 `ddl-entity-table.sql` 对应 `ddl-entity-table`。

维护规则：

- 只在 `schema/templates/` 维护 SQL / SurrealQL 模板，不再使用仓库根目录 `templates/`。
- DDL 模板使用 `$param` 占位符风格，和本目录现有 `ddl-*.sql` 保持一致。
- 动态标识符参数必须由代理服务做白名单校验；客户端只提交 `{ id, params }`。
- `field_assert` 没有断言时传空字符串，避免模板里残留未替换占位符。
