Status: done
Label: done

# WP-D2-05 — Workspace 切换器（Workspace Scope Module）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/components/WorkspaceSwitcher.svelte
web/src/lib/switch-workspace.ts          -- 调 /api/session/switch-workspace + 重新 signin
```

`workspace-store.ts` 已在 issue 03 实现；本 issue 补 workspace 列表加载与 `switchWorkspace(slug)`。

### 行为

1. 首页加载时调 `GET /api/session/workspaces`，渲染 dropdown。
2. 当前 workspace 由 token scope 中 `https://surrealdb.com/db` 与列表中的 `dbName` 匹配得出。
3. 选中 slug 后：
   a. 调 `POST /api/session/switch-workspace { workspaceSlug: slug }`。
   b. 后端更新 IdP token scope 后返回 `{ refreshRequired: true }`。
   c. 前端调用 `refresh()` silent refresh，拿到新 token。
   d. 调 `enterWorkspace(newToken)` → 新 db 连接建立，旧连接关闭。
   e. URL 更新到 `/w/<slug>`，UI 重渲染。
4. "新建 workspace"按钮 → 启 issue 06 流程。
5. workspace-store 暴露 `connectionState`，UI 在 connecting / open / closed 时分别渲染。

UI：顶栏右上角 dropdown，列 `/api/session/workspaces` 返回的 workspace + 当前选中高亮 + "新建 workspace"按钮（是否显示由后端返回的 capability 或 token claim 决定）。

### 不再做

- ❌ 从 token 的 `available_workspaces` 读列表。
- ❌ 直接调用 IdP switch endpoint。
- ❌ 用 sessionStorage 自行决定默认 workspace；默认 workspace 由 IdP 登录 hook + Workspace Scope Module 决定。

## Acceptance criteria

- [ ] 有 N workspace → 顶栏 dropdown 显示 N 条，当前 token scope 对应项高亮。
- [ ] 选中另一个 workspace → `/api/session/switch-workspace` 被调用，silent refresh 后 SurrealDB 重连到新 db。
- [ ] 用户尝试切到无权限 workspace → 后端 403，旧连接保持不变。
- [ ] OIDC token 临到期前 silent refresh 后，SurrealDB 重新 signin。
- [ ] 切换 workspace 时旧 SurrealDB 连接被 close；新连接 LIVE 订阅与旧的不冲突。
- [ ] 有创建权限的用户看到"新建 workspace"按钮；无权限用户看不到。

## Blocked by

- `.scratch/web-frontend-migration/issues/02-oidc-login-shell.md`
- `.scratch/web-frontend-migration/issues/03-surrealdb-direct-client.md`
- `.scratch/web-frontend-migration/issues/04-api-client.md`
- `.scratch/workspace-as-db/issues/03-workspace-scope-module.md`

## Notes

- 不用 router 库；URL 解析手写 `/^\/w\/([^/]+)/` 即可，MVP 路由极少。
- 列表数据是应用权威，不来自 IdP。
