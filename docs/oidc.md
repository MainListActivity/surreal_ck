# OIDC SPA Client Integration

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
| Token Auth | None (public client) |
| Audience | `https://auth.maplayer.top` |

## Endpoints

| Endpoint | URL |
|---|---|
| Authorization | `https://o.maplayer.top/t/ck/authorize` |
| Token | `https://o.maplayer.top/t/ck/token` |
| UserInfo | `https://o.maplayer.top/t/ck/userinfo` |

## Integration Notes

- This is a **public SPA client** — no client secret is used.
- **PKCE is mandatory.** Generate a `code_verifier`, derive a SHA-256 `code_challenge`, and include `code_challenge_method=S256` in the authorize request.
- The access token audience is `https://auth.maplayer.top` — validate this in your resource server.
- Tokens are signed JWTs. Verify signatures using keys from the JWKS endpoint.
- Use `openid` as the minimum scope. Add `profile`, `email` as needed.
- Persistent desktop login requires `offline_access` so the token endpoint can return a `refresh_token`.

## Workspace Token Scope（本应用专用）

本应用要求 token 中携带两个标准 SurrealDB scope claim，SurrealDB 的 `DEFINE ACCESS` AUTHENTICATE 据此把会话约束到某个 workspace database：

| Claim | 含义 |
|---|---|
| `https://surrealdb.com/db` | 当前 workspace database 名，例如 `ws_a1b2c3d4e5f6`。 |
| `https://surrealdb.com/ac` | 当前 SurrealDB access 名，MVP 为 `admin` 或 `participant`。 |

这两个 claim 的取值由**本应用**（后端 Workspace Scope Module）决定，不是用户登录时固定的：

- **登录默认 scope**：IdP 登录流程回调本应用 `GET /api/internal/idp/default-scope`，本应用按 subject 查 `_system.user_workspace_index` 返回默认 `{ db, ac }`，IdP 据此签发首个 token。
- **切换 / 创建 workspace**：本应用调用 IdP 的 **scope 更新 API** 改写该 subject 下次 token 的 `db` / `ac`，前端再 silent refresh 拿到新 scope 的 token，重新 `db.signin`。

> **TODO（簇 C issue 03 回填）**：IdP scope 更新 API 与 default-scope hook 的具体 endpoint URL、鉴权方式（管理 token / HMAC）、请求与返回 body、失败码。架构决策见 [`adr/frontend-direct-connect.md`](./adr/frontend-direct-connect.md) §3。

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
curl -X POST https://o.maplayer.top/t/ck/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=<AUTH_CODE>" \
  -d "redirect_uri=https://docs.maplayer.top/callback" \
  -d "client_id=b10df483-1cd4-4beb-8a01-92e8f4b3fdf4" \
  -d "code_verifier=<CODE_VERIFIER>"
```
