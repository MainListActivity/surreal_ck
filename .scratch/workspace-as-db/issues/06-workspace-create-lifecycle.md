Status: needs-triage
Label: needs-triage

# WP-C-06 — workspace create lifecycle endpoint

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/routes/workspaces.ts
server/src/workspaces/create-workspace.ts
```

HTTP endpoint：`POST /api/workspaces`

该 endpoint 是 workspace lifecycle，不是业务数据 CRUD 代理。它集中处理 root 建库、模板应用、owner user、`_system` 索引和 IdP scope 切换，避免浏览器持有 NS-admin 能力。

## Input

```ts
{
  name: string;
  slug: string;
}
```

## Flow

1. `requireOidc()` 解析当前 subject / email。
2. 校验用户是否有创建 workspace 权限（MVP 可先用配置 allowlist 或 token claim，后续接计费 / entitlement）。
3. 生成 `db_name = ws_<id12>`；slug 只用于 URL，不进入 db 名。
4. root 创建 workspace database。
5. 应用 `shared/sql/workspace-template/` 当前所有模板。
6. 创建 owner user：human、is_admin=true、subject/email 来自 OIDC。
7. 写 `_system.workspace`。
8. 写 `_system.user_workspace_index`，role=`admin`，`last_selected_at=time::now()`。
9. 调 `IdpTokenScopeAdapter.updateUserScope(subject, { db: db_name, ac: 'admin' })`。
10. 返回 `{ slug, dbName, refreshRequired: true }`。

## Compensation

- 模板应用失败：尝试删除刚创建的 workspace database；删除失败时记录 error 日志并返回可人工修复的错误码。
- `_system` 写入失败：尝试删除刚创建的 workspace database。
- IdP scope 更新失败：不删除 workspace；返回 `scope-update-failed`，前端允许重试 switch-workspace。

## Acceptance criteria

- [ ] 成功创建后，SurrealDB 中存在新 workspace database，模板表齐全。
- [ ] `_system.workspace` 与 `_system.user_workspace_index` 都有对应行。
- [ ] owner user 在新 workspace db 内存在，且 `is_admin=true`。
- [ ] IdP adapter 被调用一次，参数为新 db + admin access。
- [ ] 模板中途失败时，新 db 被删除或至少有明确日志标识需人工清理。
- [ ] slug 重复返回 409，不创建 db。

## Blocked by

- `.scratch/workspace-as-db/issues/02-workspace-template-sql.md`
- `.scratch/workspace-as-db/issues/03-workspace-scope-module.md`

## Notes

- 浏览器不再执行 `DEFINE DATABASE`。
- 本 endpoint 可以被 D2 的"新建 workspace"对话框和 Virtual Office onboarding wizard 复用。
