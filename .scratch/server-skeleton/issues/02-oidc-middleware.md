Status: done
Label: done

# WP-B-02 — OIDC verify middleware

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

```
server/src/
  middleware/
    oidc.ts            -- requireOidc() 中间件
  oidc/
    jwks.ts            -- JWKS fetcher + 5min cache
    verify.ts          -- jose-based JWT verify
```

`requireOidc()` 行为：

1. 取 `Authorization: Bearer <jwt>`。
2. 用 `jose.createRemoteJWKSet` + 5 分钟缓存（用 jose 自带 cooldown）。
3. verify(签名 + iss + aud + exp)；失败 → 401 `{ error: { code: 'oidc-invalid', ... } }`。
4. 成功 → `c.set('user', { subject: payload.sub, email: payload.email, raw: payload, rawToken: jwt })`。

shared 内补 `User` DTO：

```ts
export type SessionUser = {
  subject: string;
  email?: string;
  raw: Record<string, unknown>;
  rawToken: string;     // 透传到 SurrealDB SIGNIN 用
};
```

`server/src/app.ts` 顶部不挂 requireOidc——在 Mastra `/api/chat*` 与 Workspace Scope Module 的用户入口上挂。前端业务读写 SurrealDB、IdP default-scope hook、health 不经过本中间件。

env 新增：

- `OIDC_ISSUER`（如 `https://o.maplayer.top/t/ck`）
- `OIDC_JWKS_URL`（如 `https://o.maplayer.top/t/ck/jwks.json`）
- `OIDC_AUDIENCE`（如 `https://auth.maplayer.top`）

## Acceptance criteria

- [x] 不携带 Authorization 调受保护 endpoint → 401。
- [x] 携带过期 / 签名错误 / aud 不匹配的 token → 401，错误码可区分。
- [x] 正确 token → 通过，`c.var.user.subject === payload.sub`。
- [x] JWKS 在 5 分钟窗口内只 fetch 一次（用 nock / msw 验证或对 issuer fake URL 计数）。
- [x] OIDC 失败的请求**不**把 token 内容写入日志。

## Notes

- 直接用 `jose` 不用 `hono/jwt`：后者需要硬编码 secret，不支持 JWKS URL 自动校验。
- 5 分钟 cache TTL 与 [`backend-framework-hono.md`](../../../docs/adr/backend-framework-hono.md) 一致。
- iss / aud 校验是防"另一个 IdP 签的同 sub 也能进来"，必须开。
- 2026-05-21 TDD audit：新增 `server/src/middleware/oidc.test.ts`，用本地 fake JWKS + jose 签发 token 覆盖 missing bearer、valid token、JWKS cache reuse、expired、bad signature、bad audience，并修正 middleware 让 expired/audience 错误码可区分。
