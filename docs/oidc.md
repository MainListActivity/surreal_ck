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

## Example Authorization Request

```
https://o.maplayer.top/t/ck/authorize?
  response_type=code&
  client_id=b10df483-1cd4-4beb-8a01-92e8f4b3fdf4&
  redirect_uri=https://docs.maplayer.top/callback&
  scope=openid&
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
