Status: ready-for-agent
Label: ready-for-agent

# WP-C-03 — Workspace Scope Module

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/workspaces/workspace-scope.ts
server/src/workspaces/idp-scope-adapter.ts
server/src/routes/session.ts
server/src/routes/internal-idp.ts
```

Workspace Scope Module 是后端保留的深 Module：它不代理业务数据，只管理"当前 OIDC subject 能进入哪些 workspace、以什么 SurrealDB access 进入"。

### IdP Token Scope Adapter

封装 IdP 的 scope 更新接口。Interface：

```ts
export type SurrealTokenScope = {
  db: string;
  ac: 'admin' | 'participant';
};

export interface IdpTokenScopeAdapter {
  updateUserScope(subject: string, scope: SurrealTokenScope): Promise<void>;
}
```

Adapter 负责把 `db` / `ac` 映射到 IdP token claims：

- `https://surrealdb.com/db`
- `https://surrealdb.com/ac`

### `GET /api/session/workspaces`

用户已登录当前应用后调用。

处理：

1. `requireOidc()` 解析 subject。
2. root 查 `_system.user_workspace_index`，过滤 `disabled_at = NONE`。
3. join / 读取 `_system.workspace` 得到 slug、name、db_name、role、last_selected_at。
4. 返回按 `last_selected_at DESC` 排序的列表。

### `POST /api/session/switch-workspace`

入参：

```ts
{
  workspaceSlug?: string;
  dbName?: string;
}
```

处理：

1. `requireOidc()` 解析 subject。
2. 在 `_system.user_workspace_index` 查目标 workspace 行。
3. 验证目标 workspace database 内也有对应 human `user` 记录；若 index 和 user 表轻微漂移，按安全规则修复或返回 409。
4. 根据 `user.is_admin` 得出 access：`admin` 或 `participant`。
5. 更新 `_system.user_workspace_index.last_selected_at`。
6. 调 `IdpTokenScopeAdapter.updateUserScope(subject, { db, ac })`。
7. 返回 `{ ok: true, refreshRequired: true }`；前端随后 silent refresh / reload token。

### `GET /api/internal/idp/default-scope`

IdP 登录 hook 调用，用于给即将签发的 token 决定默认 SurrealDB scope。

鉴权：

- 使用 `IDP_HOOK_SECRET` 或 IdP 选型支持的 mTLS / bearer token。
- 不使用普通 OIDC，因为这是 IdP → 应用的机器调用。

入参（query 或 header，按 IdP 能力定）：

```ts
{
  subject: string;
  email?: string;
}
```

处理：

1. 查 `_system.user_workspace_index` 中该 subject 的 active rows。
2. 优先 `last_selected_at` 最新的 row。
3. 没有最近选择则取第一个 active row。
4. 没有任何 row → 返回明确的 login-denied 响应。
5. 返回 `{ db, ac }`，由 IdP 写入 `https://surrealdb.com/db` / `https://surrealdb.com/ac` claims。

## Acceptance criteria

- [ ] 有 3 个 workspace 的用户调用 `/api/session/workspaces` → 返回 3 条，最近选择在最前。
- [ ] 用户切到自己无权限的 workspace → 403，IdP adapter 未被调用。
- [ ] 用户切到有权限 workspace → `last_selected_at` 更新，IdP adapter 收到正确 `{ db, ac }`。
- [x] IdP default-scope hook 对无 workspace 用户返回 login-denied，前端不会进入应用。
- [x] IdP default-scope hook 对有 workspace 用户返回最近选择的 db/ac。
- [ ] 所有失败路径都不把 OIDC token 或 IdP admin token 写入日志。

## Blocked by

- `.scratch/workspace-as-db/issues/01-system-schema-seed.md`
- `.scratch/workspace-as-db/issues/02-workspace-template-sql.md`

## Notes

- 本 issue 不实现 workspace 创建；见 WP-C-06。
- 本 issue 不实现成员管理 UI；但必须把 index 校验和漂移错误码设计好，给后续成员管理 issue 使用。
- IdP 选型未定时，先实现内存 / fake adapter，方便前端和集成测试跑通。

## 2026-05-22 TDD slice: IdP default-scope hook

已完成最小垂直切片：

- 新增 `server/src/workspaces/workspace-scope.ts`，提供 `WorkspaceScopeModule.getDefaultScope()`，从 `_system.user_workspace_index` 读取 subject 可进入的 active workspace，并按 `last_selected_at DESC` 选择默认 scope。
- 新增 `server/src/routes/internal-idp.ts`，挂载 `GET /api/internal/idp/default-scope`，使用 `requireInternalHook()` 保护，不使用普通 OIDC。
- `createApp()` 支持注入 `workspaceScope`，测试可走 public HTTP route，不依赖真实 IdP 或真实 root 连接。

TDD 覆盖：

- `server/src/routes/internal-idp.test.ts`：有 workspace 返回 `{ db, ac }`；无 active workspace 返回 403 `login-denied`。
- 本地 SurrealDB 3.0.5 内存实例验证：`workspace:archived` 即使 `last_selected_at` 最新也会被过滤；返回最近的 active workspace `ws_recent/admin`。

Remaining:

- `GET /api/session/workspaces`
- `POST /api/session/switch-workspace`
- `IdpTokenScopeAdapter.updateUserScope()`
- switch-workspace 对 workspace db `user` 表的一致性校验与漂移错误码
- 失败路径 token / IdP admin token 日志红action专项测试
