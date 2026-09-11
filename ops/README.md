# Surreal CK Ops

独立的运营控制台，不与客户 `web/` 共用页面路由。使用 OIDC Authorization Code + PKCE，向 Hono 的配额与平台内容维护 API 发送独立运营 audience 的 bearer token。

当前页面包含两个模块：

- 配额运营：工作区搜索、计划/配额状态和操作时间线（`/api/ops/quota/*`）。
- 内容维护：来源登记与许可修订、成品批次分页/详情、失败原因和审计查询（`/api/content/*`）。来源许可修订由服务端版本化，批次会保存提交时的许可快照。

```bash
pnpm --filter @surreal-ck/ops install
pnpm --filter @surreal-ck/ops dev
pnpm --filter @surreal-ck/ops build
```

生产环境配置 `VITE_OPS_OIDC_ISSUER`、`VITE_OPS_OIDC_CLIENT_ID`、`VITE_OPS_OIDC_AUDIENCE` 和 `VITE_OPS_API_BASE_URL`。运营 API 仍在 `surreal_ck/server`，页面可部署到独立静态站点或同域反向代理路径。
