Status: done
Label: done

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

- [~] 无痕窗口访问根 URL → 重定向 IdP → 登录 → 回到首页 + token / claims 存好。 _（代码路径已落，未现场跑真实 IdP 登录）_
- [x] `getClaims()['https://surrealdb.com/db']` 是有效 ws db name。 _（`AuthClaims` 与 runtime guard 要求该 claim 是 string）_
- [x] token 过期前 silent refresh 不闪屏；失败 → 跳 login。
- [x] logout 后回到 login 页；sessionStorage 清空。 _（本 issue 清 sessionStorage + 交给 IdP `signoutRedirect`；实际回跳依赖 IdP 配置）_
- [x] 错误 state / 无 code 等异常情况显示明确错误页。
- [x] OIDC code/token exchange 不调后端；workspace 列表 / 切换由后续 issue 调 Workspace Scope Module。

## Notes

- 选 SPA OIDC：token 是 SurrealDB access 的直接输入。MVP 接受 sessionStorage 风险，但必须配合 CSP、markdown sanitize 和第三方脚本约束。
- 长期可改成"后端 set httpOnly cookie + 中间件 verify"，但要求引入后端会话管理——超出当前 ADR 范围。
- token 不塞 workspace 列表；列表来自 `/api/session/workspaces`。

## 落地记录（2026-05-28）

- 新增依赖 `oidc-client-ts@^3.5.0`，只落在 `@surreal-ck/web` workspace。
- 新增 `web/src/lib/auth.ts`：统一封装 OIDC SPA client、`sessionStorage` key（`oidc.access_token` / `oidc.id_token` / `oidc.exp` / `oidc.claims`）、claim runtime guard、`getToken()` / `getClaims()` / `isAuthenticated()` / `refresh()` / `logout()` / `login()` / `handleCallback()` / `requireAuthenticatedRoute()`。
- 新增 `web/src/routes/auth/login.svelte` 与 `web/src/routes/auth/callback.svelte`：login 页触发 `signinRedirect`；callback 页处理 code/state、成功后回 `returnTo`，失败时显示明确错误。
- 更新 `web/src/App.svelte`：普通 Vite SPA 内做最小路由分发，业务路由未登录跳 `/auth/login?returnTo=...`；已登录首页显示当前 token claims 中的 workspace db/access；每分钟调用 `refresh()`，5 分钟窗口内 silent renew。
- 更新 `web/src/env.d.ts`：声明 `VITE_OIDC_ISSUER` / `VITE_OIDC_CLIENT_ID` / `VITE_OIDC_REDIRECT_URI` / `VITE_OIDC_AUDIENCE`。
- 更新 `web/vite.config.ts`：`optimizeDeps.entries = ["index.html"]`，避免 dev server 预构建扫描 `web/legacy` 里的旧 Electrobun import。
- TDD：新增 `web/src/lib/auth.test.ts`，覆盖 session 恢复、callback 持久化、callback 缺 code/state、5 分钟 silent refresh、refresh 失败/空用户跳 login、logout 清理、业务路由 guard、login redirect state。
- 验收命令：
  - `pnpm --filter @surreal-ck/web test`：15 pass（含 Vite legacy scan 回归）。
  - `pnpm --filter @surreal-ck/web typecheck`：tsc + svelte-check 0 error / 0 warning。
  - `pnpm --filter @surreal-ck/web build`：Vite build 成功。
  - `pnpm -r run typecheck`：shared / server / web 全绿。
  - `pnpm -r --if-present run test`：shared 18 + server 116 + web 15 全绿。
- 本地烟测：`pnpm --filter @surreal-ck/web dev --host 127.0.0.1` 启动在 `http://127.0.0.1:5173/`；浏览器访问根路径会跳到 `/auth/login?returnTo=%2F`。当前本地未提供 `VITE_OIDC_*`，页面显示 `OIDC client is not configured`，无 console error。
