# OIDC Web Client Integration

## Identity Provider

This application authenticates users via an OpenID Connect provider.

- **Issuer:** `https://o.maplayer.top/t/ck`
- **Discovery:** `https://o.maplayer.top/t/ck/.well-known/openid-configuration`
- **JWKS:** `https://o.maplayer.top/t/ck/jwks.json`

## Client Configuration

| Field | Value |
|---|---|
| Client ID | `b10df483-1cd4-4beb-8a01-92e8f4b3fdf4` |
| Redirect URI | `https://docs.maplayer.top/callback` |
| Grant Type | `authorization_code` |
| Response Type | `code` |
| PKCE | Required (S256) |
| Token Auth | Confidential client via Bun server |
| Audience | `https://auth.maplayer.top` |

## Endpoints

| Endpoint | URL |
|---|---|
| Authorization | `https://o.maplayer.top/t/ck/authorize` |
| Browser token exchange | `/api/auth/token` |
| Upstream IdP Token | `https://o.maplayer.top/t/ck/token` |
| UserInfo | `https://o.maplayer.top/t/ck/userinfo` |

## Integration Notes

- This is a **Web confidential client**. The browser still performs the authorization redirect/callback flow, but token exchange calls this application's `/api/auth/token` endpoint.
- `client_secret` is server-only (`OIDC_CLIENT_SECRET`) and must never appear in `VITE_*`, frontend bundles, URLs, logs, or browser storage.
- `/api/auth/token` forwards the authorization code exchange to the IdP token endpoint with the server-side confidential client credentials, then returns the IdP `access_token` to the browser.
- `OIDC_TOKEN_AUTH_METHOD` defaults to `client_secret_basic`; set it to `client_secret_post` only when the IdP client is configured that way.
- The browser continues to use that `access_token` as the application API bearer token and the SurrealDB `db.signin` token.
- `refresh_token` is not returned to the browser by `/api/auth/token`.
- **PKCE is mandatory.** Generate a `code_verifier`, derive a SHA-256 `code_challenge`, and include `code_challenge_method=S256` in the authorize request.
- The access token audience is `https://auth.maplayer.top` — validate this in your resource server.
- Tokens are signed JWTs. Verify signatures using keys from the JWKS endpoint.
- Use `openid` as the minimum scope. Add `profile`, `email` as needed.
- `offline_access` may be requested only if the backend is prepared to retain refresh capability server-side.

## Workspace Token Scope（本应用专用）

最终 access token 使用 SurrealDB 识别的短 claim（官方也支持 namespaced 别名，但本项目代码统一使用短名）：

| Claim | 来源 | 含义 |
|---|---|---|
| `db` | surreal_ck 登录 hook / scope exchange | 当前 workspace database，例如 `ws_a1b2c3d4e5f6`。 |
| `ac` | surreal_ck 登录 hook / scope exchange | 当前 SurrealDB access：`admin` 或 `participant`。 |
| `RL` | IdP client 固定配置；scope exchange 当前也显式重申 | 固定 system role `['Owner']`；只在 JWT system access 中解释。 |

### 权限分流不变量

IdP 是 token 签名者，不是 workspace 权限权威。它每次正常签发 access token 时调用本应用 `GET /api/internal/idp/default-scope`，由 Workspace Scope Module 决定 `db` / `ac`；IdP client 配置固定加入 `RL=['Owner']`。

- `ac=admin` → `DEFINE ACCESS admin TYPE JWT`：这是 database system user，`RL=['Owner']` 生效，因此管理员可执行 DDL + DML。
- `ac=participant` → `DEFINE ACCESS participant TYPE RECORD WITH JWT`：RECORD user 不使用 system RBAC；无论正常登录时固定的 `RL=['Owner']`，还是 scope exchange 显式重申的其它 `RL`，都不授予 system role，只能按表 / 字段 PERMISSIONS 执行 DML。

因此，**不能从 participant token 携带的 `RL` 推断普通成员拥有 DDL**。真正的能力分流点是由本应用 hook 决定、用户不能自行选择的 `ac`。

签发路径：

- **登录默认 scope**：IdP 在 `/token` 签发前调用本应用 hook；本应用按 subject 查 `_system.user_workspace_index` 返回 `{ db, ac, can_create_workspace }`，IdP 合并固定 `RL` 后签发首个 token。
- **切换 / 创建 workspace**：本应用后端用 server-only `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` 调 IdP `/scope`，提交当前 `subject_token` 与目标 `db` / `ac`（当前 Adapter 同时提交对应 `RL`）。IdP 校验 confidential client、原 token 的 tenant/client/subject，并在换发时再次解析已配置的 hook claims；浏览器不能为任意 subject mint token。

`_system.system_admin` 仅实现部署级 **workspace 创建开关**：表非空时所有已登录真人可创建 workspace，表为空时全部禁止。它不是逐 subject allowlist；行内 subject 只用于 seed / 审计。

Scope exchange 请求由 Bun server 发出，浏览器永远不接触 `OIDC_CLIENT_SECRET`：

```http
POST https://o.maplayer.top/t/ck/scope
Authorization: Basic base64(OIDC_CLIENT_ID:OIDC_CLIENT_SECRET)
Content-Type: application/json

{
  "subject_token": "<CURRENT_USER_ACCESS_TOKEN>",
  "claims": {
    "db": "ws_a1b2c3d4e5f6",
    "ac": "admin",
    "RL": ["Owner"]
  }
}
```

## Example Authorization Request

```
https://o.maplayer.top/t/ck/authorize?
  response_type=code&
  client_id=b10df483-1cd4-4beb-8a01-92e8f4b3fdf4&
  redirect_uri=https://docs.maplayer.top/callback&
  scope=openid%20profile%20email%20offline_access&
  code_challenge=<BASE64URL_SHA256_OF_VERIFIER>&
  code_challenge_method=S256&
  state=<RANDOM_STATE>
```

## Example Token Exchange

```bash
curl -X POST https://docs.maplayer.top/api/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=<AUTH_CODE>" \
  -d "redirect_uri=https://docs.maplayer.top/callback" \
  -d "client_id=b10df483-1cd4-4beb-8a01-92e8f4b3fdf4" \
  -d "code_verifier=<CODE_VERIFIER>"
```

The Bun server forwards this request to `OIDC_TOKEN_ENDPOINT` with `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, using `OIDC_TOKEN_AUTH_METHOD` for client authentication.
