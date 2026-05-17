Status: needs-triage
Label: needs-triage

# WP-C-02 — workspace 模板 schema 文件（前后端共享）

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
shared/sql/workspace-template/
  001-access.surql        -- DEFINE ACCESS admin / participant / employee
  002-tables-core.surql   -- user / schema_version
  003-tables-office.surql -- office_role / employee_credential
```

内容对齐 virtual-office/issue-01 §B（三条 access + user + office_role + employee_credential）；access 的 AUTHENTICATE 按 [`docs/adr/workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) §1（read claim → CREATE user if NONE → UPDATE last_seen_at）。

**后端创建与迁移共享**：

- Workspace Scope Module 创建新 db 时执行——参见 [`frontend-direct-connect.md`](../../../docs/adr/frontend-direct-connect.md) §5。
- 后端 schema migration runner **用于既有 db 增量**——参见 issue 04。
- 共享靠 `shared/sql/workspace-template/index.ts` 暴露 `WORKSPACE_TEMPLATE_VERSION` + `loadTemplateScripts()`。

**JWKS URL 占位**：

- SQL 文件中三条 access 的 URL 用 `<__OIDC_JWKS_URL__>` 占位。
- 后端创建 workspace 与 migration runner 都用 `process.env.OIDC_JWKS_URL` 替换。

## Acceptance criteria

- [ ] 三个 surql 文件可由 SurrealQL 语法校验通过（手动 IMPORT 或 CLI lint）。
- [ ] `loadTemplateScripts()` 返回有序数组，version 与文件名对齐。
- [ ] `<__OIDC_JWKS_URL__>` 占位符在三处 access DEFINE 中存在。
- [ ] Workspace Scope Module 创建新 db 时可读取这些脚本并按序执行。
- [ ] migration runner 与 create-workspace 使用同一个 `loadTemplateScripts()`，不会出现两套模板。

## Blocked by

- `.scratch/workspace-as-db/issues/01-system-schema-seed.md`

## Notes

- 把模板拆 3 个文件而非一个 monolithic：迁移时可独立地知道"哪一段挂了"。
- 未来虚拟办公室四表 schema 会作为 `004-tables-vo.surql` / `005-...` 加入；本 issue 不预占。
- 创建新 db 与迁移既有 db 都由后端 root 路径执行；浏览器不持 NS-admin token。
- 本 issue 不实现"创建 workspace"逻辑（属于 WP-C-06），也不实现 runner（属于 WP-C-04）；本 issue 只产出共享的 SQL 文件 + index.ts。
