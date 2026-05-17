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

token claim 形态（与 IdP 选型对齐，参见 [`frontend-direct-connect.md`](../../../docs/adr/frontend-direct-connect.md) Open Question §2）：

```ts
{
  sub: string;
  email: string;
  name?: string;
  current_db: string;          // 当前选中的 workspace 对应 db
  role: 'admin' | 'participant';
  ns_admin?: boolean;          // 仅 create-workspace 那一刻临时为 true
  available_workspaces?: Array<{ slug, name, db_name, role }>;   // 用于 switcher 列表
}
```

env：

- `VITE_OIDC_ISSUER`
- `VITE_OIDC_CLIENT_ID`
- `VITE_OIDC_REDIRECT_URI`
- `VITE_OIDC_AUDIENCE`

## Acceptance criteria

- [ ] 无痕窗口访问根 URL → 重定向 IdP → 登录 → 回到首页 + token / claims 存好。
- [ ] `getClaims().current_db` 是有效 ws db name。
- [ ] token 过期前 silent refresh 不闪屏；失败 → 跳 login。
- [ ] logout 后回到 login 页；sessionStorage 清空。
- [ ] 错误 state / 无 code 等异常情况显示明确错误页。
- [ ] **整个流程不调任何后端 endpoint**（浏览器直连 IdP）。

## Notes

- 选 SPA OIDC：后端无 session 表，token 是 SurrealDB access 的直接输入。MVP 接受 sessionStorage 风险（同源 + IdP 控权 + DEFINE ACCESS 兜底，威胁面较小）。
- 长期可改成"后端 set httpOnly cookie + 中间件 verify"，但要求引入后端会话管理——超出当前 ADR 范围。
- `available_workspaces` 是否塞在 token 里待 IdP 选型敲定；如果太大则改用单独的 IdP query endpoint，前端拉一次缓存。
