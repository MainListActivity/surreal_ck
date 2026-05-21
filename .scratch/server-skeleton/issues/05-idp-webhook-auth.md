Status: done
Label: done

# WP-B-05 — internal hook 鉴权中间件

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

```
server/src/middleware/internal-hook-auth.ts
```

`requireInternalHook()` 中间件用于 IdP default-scope hook 等机器到机器入口。

MVP 支持 bearer secret：

1. 取 `Authorization: Bearer <token>`。
2. 与 `IDP_HOOK_SECRET` 常量时间比较。
3. 不匹配 → 401，错误码 `internal-hook-auth-invalid`。
4. 匹配 → 通过。

如果最终 IdP 选型只支持 HMAC webhook 签名，本中间件可以在 issue 阶段扩展 raw body HMAC 校验；但 Interface 名称保持 `requireInternalHook()`，避免把实现细节暴露给 route。

env 新增：

- `IDP_HOOK_SECRET`（高熵随机串；与 IdP 登录 hook 配置共享）

## Acceptance criteria

- [x] 正确 bearer secret → 通过。
- [x] 缺 Authorization → 401。
- [x] 错误 secret → 401。
- [x] 失败请求不把 header/body 写入日志。
- [x] 中间件不解析业务 payload；payload 内容由 endpoint 自行 zod 校验。

## Blocked by

- `.scratch/server-skeleton/issues/01-hono-app-skeleton.md`

## Notes

- 这个中间件不是普通用户 OIDC 校验；它只保护 IdP → 应用的 hook。
- 上线前若 IdP 支持 mTLS，可在网关层加 mTLS，本中间件仍保留应用层密钥校验。
- 2026-05-21 TDD audit：新增 `server/src/middleware/internal-hook-auth.test.ts`，通过 Hono public route 覆盖正确 bearer、缺失 bearer、错误 bearer，并断言失败日志不包含 header/body secret。
