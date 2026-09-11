# Surreal CK Ops

独立的运营控制台，不与客户 `web/` 共用页面路由。首期使用 OIDC Authorization Code + PKCE，向 Hono 的 `/api/ops/quota/*` 发送独立运营 audience 的 bearer token。

```bash
pnpm --filter @surreal-ck/ops install
pnpm --filter @surreal-ck/ops dev
pnpm --filter @surreal-ck/ops build
```

生产环境配置 `VITE_OPS_OIDC_ISSUER`、`VITE_OPS_OIDC_CLIENT_ID`、`VITE_OPS_OIDC_AUDIENCE` 和 `VITE_OPS_API_BASE_URL`。运营 API 仍在 `surreal_ck/server`，页面可部署到独立静态站点或同域反向代理路径。
