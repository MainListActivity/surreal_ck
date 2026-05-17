Status: needs-triage
Label: needs-triage

# WP-D2-05 — Workspace 切换器（驱动 IdP silent refresh）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/components/WorkspaceSwitcher.svelte
web/src/lib/switch-workspace.ts          -- 调 IdP silent refresh + 重新 signin
```

`workspace-store.ts` 已在 issue 03 实现；本 issue 只补 `switchWorkspace(slug)` 函数。

### 行为

1. 首页加载时从 OIDC claims 拿 `available_workspaces`（issue 02 解析），渲染 dropdown。
2. URL 形如 `/w/:slug/*` 时从 path 取 slug；否则用 sessionStorage 最近一次 slug；都没有则用 token.current_db 默认。
3. 选中 slug 后：
   a. 调 IdP "switch workspace" endpoint（silent iframe / fetch + PKCE，参数 `target_workspace=<slug>`）。
   b. 拿到新 token（含新 `current_db` claim）→ 存 sessionStorage。
   c. 调 `enterWorkspace(newToken)`（issue 03 暴露的）→ 新 db 连接建立，旧的关闭。
   d. URL 更新到 `/w/<slug>`，UI 重渲染。
4. "新建 workspace" 按钮 → 启 issue 06 流程。
5. workspace-store 暴露 `connectionState`，UI 在 "connecting / open / closed" 时分别渲染。

UI：顶栏右上角 dropdown，列所有 available_workspaces + 当前选中高亮 + "新建 workspace" 按钮（仅 `can_create_workspace=true` 的用户可见）。

### 不再做

- ❌ 调 `/api/sessions/bootstrap`（后端没有这个 endpoint；workspace 列表来自 IdP token）
- ❌ 调 `/api/sessions`（同上；signin 直接走 surrealdb-js）
- ❌ 后端 token 续期（IdP silent refresh 取代）

## Acceptance criteria

- [ ] 首次登录 + 0 workspace 用户被带到"新建 workspace"引导页（issue 06）。
- [ ] 有 N workspace → 顶栏 dropdown 显示，选中触发 IdP refresh → 新 db 连接 → URL 同步。
- [ ] 刷新页面后保留上次 workspace（sessionStorage 暂存最后 slug，启动时优先用）。
- [ ] OIDC token 临到期前 5 分钟自动 silent refresh（issue 02 已实现）；连带 SurrealDB 重新 signin。
- [ ] 切换 workspace 时旧 SurrealDB 连接被 close；新连接 LIVE 订阅与旧的不冲突。
- [ ] 非 `can_create_workspace` 用户看不到"新建"按钮。

## Blocked by

- `.scratch/web-frontend-migration/issues/02-oidc-login-shell.md`
- `.scratch/web-frontend-migration/issues/03-surrealdb-direct-client.md`

## Notes

- IdP 切换 endpoint 的具体形态待选型；本 issue 用占位接口名。
- 不用 router 库；URL 解析手写 `/^\/w\/([^/]+)/` 即可，MVP 路由极少。
