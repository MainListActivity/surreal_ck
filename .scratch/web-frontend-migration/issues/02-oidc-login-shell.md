Status: needs-triage
Label: needs-triage

# WP-D2-02 — OIDC 登录壳（SPA，不经过后端）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/routes/auth/login.svelte     -- 触发 OIDC redirect
web/src/routes/auth/callback.svelte  -- 处理回调
web/src/lib/auth.ts                  -- token store / silent refresh / logout / claim parse
```

依赖：`oidc-client-ts`（SPA Auth Code + PKCE，标准实现）。

行为：

1. 未登录用户访问任何路由 → 重定向到 `/auth/login`。
2. login 页：构造 IdP authorize URL（state + PKCE），跳转。
3. callback 页：拿到 code，换 token，存 sessionStorage（key: `oidc.access_token` / `oidc.id_token` / `oidc.exp` / `oidc.claims`）。
4. `auth.ts` 暴露 `getToken()`、`getClaims()`、`refresh()`、`logout()`、`isAuthenticated()`。
5. token 临到期 5 分钟内自动 silent refresh；失败则跳 login。
6. logout：清 sessionStorage + 跳 IdP logout endpoint。
7. **不经过后端**——OIDC code/token exchange 是浏览器直连 IdP。

token claim 形态（与 [`frontend-direct-connect.md`](../../../docs/adr/frontend-direct-connect.md) 对齐）：

```ts
{
  sub: string;
  email: string;
  name?: string;
  'https://surrealdb.com/db': string;  // 当前 workspace database
  'https://surrealdb.com/ac': 'admin' | 'participant';
}
```

env：

- `VITE_OIDC_ISSUER`
- `VITE_OIDC_CLIENT_ID`
- `VITE_OIDC_REDIRECT_URI`
- `VITE_OIDC_AUDIENCE`

## Acceptance criteria

- [ ] 无痕窗口访问根 URL → 重定向 IdP → 登录 → 回到首页 + token / claims 存好。
- [ ] `getClaims()['https://surrealdb.com/db']` 是有效 ws db name。
- [ ] token 过期前 silent refresh 不闪屏；失败 → 跳 login。
- [ ] logout 后回到 login 页；sessionStorage 清空。
- [ ] 错误 state / 无 code 等异常情况显示明确错误页。
- [ ] OIDC code/token exchange 不调后端；workspace 列表 / 切换由后续 issue 调 Workspace Scope Module。

## Notes

- 选 SPA OIDC：token 是 SurrealDB access 的直接输入。MVP 接受 sessionStorage 风险，但必须配合 CSP、markdown sanitize 和第三方脚本约束。
- 长期可改成"后端 set httpOnly cookie + 中间件 verify"，但要求引入后端会话管理——超出当前 ADR 范围。
- token 不塞 workspace 列表；列表来自 `/api/session/workspaces`。
