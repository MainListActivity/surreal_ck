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

**前后端共享**：

- 前端 bundle 进自己代码，**用于创建新 db 时执行**——参见 [`frontend-direct-connect.md`](../../../docs/adr/frontend-direct-connect.md) §4。
- 后端 schema migration runner **用于既有 db 增量**——参见 issue 04。
- 共享靠 `shared/sql/workspace-template/index.ts` 暴露 `WORKSPACE_TEMPLATE_VERSION` + `loadTemplateScripts()`。

**JWKS URL 占位**：

- SQL 文件中三条 access 的 URL 用 `<__OIDC_JWKS_URL__>` 占位。
- 前端用 `import.meta.env.VITE_OIDC_JWKS_URL` 替换。
- 后端用 `process.env.OIDC_JWKS_URL` 替换。
- 两边必须替换为**同一个 URL**——前后端 .env 校对靠运维流程。

## Acceptance criteria

- [ ] 三个 surql 文件可由 SurrealQL 语法校验通过（手动 IMPORT 或 CLI lint）。
- [ ] `loadTemplateScripts()` 返回有序数组，version 与文件名对齐。
- [ ] `<__OIDC_JWKS_URL__>` 占位符在三处 access DEFINE 中存在。
- [ ] 前端构建产物中 `shared/sql/workspace-template/*.surql` 作为字符串资源被 bundle（不是异步 fetch）。
- [ ] 前端 + 后端用相同 OIDC_JWKS_URL 时，对同一个新 db 应用模板得到相同 schema。

## Blocked by

- `.scratch/workspace-as-db/issues/01-system-schema-seed.md`

## Notes

- 把模板拆 3 个文件而非一个 monolithic：迁移时可独立地知道"哪一段挂了"。
- 未来虚拟办公室四表 schema 会作为 `004-tables-vo.surql` / `005-...` 加入；本 issue 不预占。
- 前端执行模板时是以 NS-admin token signin → DEFINE DATABASE → 切到 db → 应用脚本；后端 migration runner 用 root，可跳过 DEFINE DATABASE 步骤（db 已存在）。
- 本 issue 不实现"前端执行模板"逻辑（属于 web-frontend-migration 簇），也不实现"后端 runner"（属于本簇 issue 04）；本 issue 只产出共享的 SQL 文件 + index.ts。
