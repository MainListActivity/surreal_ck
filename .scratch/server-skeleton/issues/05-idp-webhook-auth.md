Status: needs-triage
Label: needs-triage

# WP-B-05 — IdP webhook 鉴权中间件

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

```
server/src/middleware/idp-webhook-auth.ts
```

`requireIdpWebhook()` 中间件：

1. 取 header `X-IdP-Signature`（具体 header 名以 IdP 选型而定，可放 env）。
2. 取 raw body。
3. 用 `IDP_WEBHOOK_SECRET` env 算 `HMAC-SHA256(body, secret)`，与 header 值常量时间比较（防 timing attack）。
4. 不匹配 → 401，错误码 `webhook-signature-invalid`。
5. 匹配 → 通过，把 raw body 解 JSON 后塞 `c.var.webhookPayload`。

env 新增：

- `IDP_WEBHOOK_SECRET`（高熵随机串；与 IdP 端共享）

## Acceptance criteria

- [ ] 正确签名的 webhook → 通过，payload 解出。
- [ ] 缺 signature → 401。
- [ ] 错误签名 → 401。
- [ ] 篡改 body 一个字符（保持签名） → 401。
- [ ] 中间件**不依赖**正文 JSON 结构，仅校验签名；payload 内容由 endpoint 自行 zod 校验。

## Blocked by

- `.scratch/server-skeleton/issues/01-hono-app-skeleton.md`

## Notes

- MVP 共享密钥 HMAC 即可；上线前升级到 mTLS（更难伪造但配置复杂）。
- header 名与签名算法跟 IdP 选型；如果选定的 IdP 用 `Webhook-Signature` v1 标准（如 Standard Webhooks），按其规范实现。
- 失败的请求**不**把 body 写入日志（防泄漏）。
