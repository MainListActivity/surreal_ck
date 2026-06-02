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

本应用要求 token 中携带两个标准 SurrealDB scope claim，SurrealDB 的 `DEFINE ACCESS` AUTHENTICATE 据此把会话约束到某个 workspace database：

| Claim | 含义 |
|---|---|
| `https://surrealdb.com/db` | 当前 workspace database 名，例如 `ws_a1b2c3d4e5f6`。 |
| `https://surrealdb.com/ac` | 当前 SurrealDB access 名，MVP 为 `admin` 或 `participant`。 |

这两个 claim 的取值由**本应用**（后端 Workspace Scope Module）决定，不是用户登录时固定的：

- **登录默认 scope**：IdP 登录流程回调本应用 `GET /api/internal/idp/default-scope`，本应用按 subject 查 `_system.user_workspace_index` 返回默认 `{ db, ac }`，IdP 据此签发首个 token。
- **切换 / 创建 workspace**：本应用后端用 server-only `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` 调 IdP `IDP_SCOPE_API_URL`，提交当前用户 `subject_token` 与目标 `db` / `ac` claims。IdP 立即返回带新 scope 的 `access_token`，前端保存该 token 后重新 `db.signin`。

Scope exchange 请求由 Bun server 发出，浏览器永远不接触 `OIDC_CLIENT_SECRET`：

```http
POST https://o.maplayer.top/t/ck/scope
Authorization: Basic base64(OIDC_CLIENT_ID:OIDC_CLIENT_SECRET)
Content-Type: application/json

{
  "subject_token": "<CURRENT_USER_ACCESS_TOKEN>",
  "claims": {
    "https://surrealdb.com/db": "ws_a1b2c3d4e5f6",
    "https://surrealdb.com/ac": "admin"
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
