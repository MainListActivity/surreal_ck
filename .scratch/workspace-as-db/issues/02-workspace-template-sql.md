Status: done
Label: done

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

- [x] 三个 surql 文件可由 SurrealQL 语法校验通过（手动 IMPORT 或 CLI lint）。
- [x] `loadTemplateScripts()` 返回有序数组，version 与文件名对齐。
- [x] `<__OIDC_JWKS_URL__>` 占位符在 JWT access DEFINE 中存在。
- [x] Workspace Scope Module 创建新 db 时可读取这些脚本并按序执行。
- [x] migration runner 与 create-workspace 使用同一个 `loadTemplateScripts()`，不会出现两套模板。

## Blocked by

- `.scratch/workspace-as-db/issues/01-system-schema-seed.md`

## Notes

- 把模板拆 3 个文件而非一个 monolithic：迁移时可独立地知道"哪一段挂了"。
- 未来虚拟办公室四表 schema 会作为 `004-tables-vo.surql` / `005-...` 加入；本 issue 不预占。
- 创建新 db 与迁移既有 db 都由后端 root 路径执行；浏览器不持 NS-admin token。
- 本 issue 不实现"创建 workspace"逻辑（属于 WP-C-06），也不实现 runner（属于 WP-C-04）；本 issue 只产出共享的 SQL 文件 + index.ts。
- 2026-05-21 TDD implementation：新增 `@surreal-ck/shared/workspace-template` subpath export，`WORKSPACE_TEMPLATE_VERSION = 3`，`loadTemplateScripts()` 读取 `001-access` / `002-tables-core` / `003-tables-office` 并保持有序。测试覆盖 raw placeholder 与传入 `oidcJwksUrl` 后统一替换。
- 2026-05-21 correction：原验收写"三处 access DEFINE 中存在 JWKS 占位符"不自洽；`employee` 是 RECORD secret `SIGNIN`，不使用 JWKS。当前模板在 `admin` 与 `participant` 两个 JWT access 中放 `<__OIDC_JWKS_URL__>`，employee access 保持 secret SIGNIN。
- 2026-05-21 integration check：用本地 SurrealDB 3.0.5 内存实例和 `surrealdb` SDK 按序执行渲染后的三个脚本，`INFO FOR DB` 显示 `admin` / `participant` / `employee` 三个 access，以及 `user` / `schema_version` / `office_role` / `employee_credential` 四张表。
