# GitHub production release

生产发布由 GitHub Actions 串成一条不可绕过的链：

1. 变更通过 Pull Request 进入 `main`。
2. `Quality gate` 执行 lint、类型检查、测试、前端构建与 Docker 构建。
3. PR 合并后，`main` 上同一 commit 再次通过 `Quality gate`。
4. `Deploy production` 先调用 `Deploy origin`，把同一 commit 发布到 Hono origin 主机；origin 健康后才发布 Cloudflare。
5. 发布后探测应用、Hono `/health` 和营销站；任一失败都会把 production deployment 标记为失败。

## Cloudflare 生产面

| 组件 | Cloudflare 资源 | 生产地址 |
| --- | --- | --- |
| Svelte 应用 | Pages `surreal-ck-app` | `https://l.maplayer.top` |
| Astro 营销站 | Pages `surreal-ck` | `https://www.maplayer.top` |
| ops 运营控制台 | 并入 Pages `surreal-ck-app` 的 `/ops/` 子路径（与运营 API 同源） | `https://l.maplayer.top/ops/` |
| Hono 边缘代理 | Worker `surreal-ck-hono-edge` | `l.maplayer.top` 的 API / WS 路由 |

ops 控制台选择同域子路径而非独立子域：运营 API 只认 `l.maplayer.top` 同源请求，静态产物打进 `web/dist/ops/` 随应用一起 `pages deploy`，不新增跨域面与 DNS 记录。构建时用 `VITE_OPS_BASE=/ops/` 注入 base；`/ops/` 验证以页面标题「运营控制台」为准，防止 SPA fallback 假阳性。

ops 上线一次性前置（不属于自动发布，需要 IdP 管理凭证执行）：

1. 在 IdP `ck` 租户登记 ops 浏览器 public client（admin 通道，`client_profile=spa`、`token_endpoint_auth_method=none`、`application_type=web`）：`redirect_uris=["https://l.maplayer.top/ops/auth/callback.html"]`、`access_token_audience` 与 `OIDC_OPS_AUDIENCE` 一致。
2. `gh secret set ORIGIN_ENV_OIDC_OPS_CLIENT_ID --env production` 硬绑定该 client_id（可选但建议，防代理被其他 client 借用）。
3. `production` Environment 配齐 `VITE_OPS_OIDC_ISSUER`、`VITE_OPS_OIDC_CLIENT_ID`、`VITE_OPS_OIDC_AUDIENCE`、`VITE_OPS_API_BASE_URL=https://l.maplayer.top/api`。

Worker 的 `EDGE_PROXY_SECRET` 已由 Cloudflare Worker Secret 管理。普通 `wrangler deploy` 会保留它；不要把该值放进仓库或 GitHub Variables。

## GitHub `production` Environment

Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Variables：

- `WEB_PAGES_PROJECT=surreal-ck-app`
- `MARKETING_PAGES_PROJECT=surreal-ck`
- `VITE_API_BASE_URL=https://l.maplayer.top`
- `VITE_SURREAL_URL=wss://data.maplayer.top/rpc`
- `VITE_OIDC_ISSUER=https://o.maplayer.top/t/ck`
- `VITE_OIDC_CLIENT_ID=b10df483-1cd4-4beb-8a01-92e8f4b3fdf4`
- `VITE_OIDC_REDIRECT_URI=https://l.maplayer.top/auth/callback`
- `VITE_OIDC_AUDIENCE=https://auth.maplayer.top`
- `VITE_OPS_OIDC_ISSUER=https://o.maplayer.top/t/ck`
- `VITE_OPS_OIDC_CLIENT_ID=<ops 控制台 client_id，IdP 登记产物>`
- `VITE_OPS_OIDC_AUDIENCE=https://l.maplayer.top/api/ops/mcp`
- `VITE_OPS_API_BASE_URL=https://l.maplayer.top/api`

这些 `VITE_*` 值会进入公开的浏览器 bundle，因此只能放公开配置；OIDC client secret、SurrealDB root 密码、模型 key 等服务端凭证绝不能放在这里。ops SPA 是纯 public client（PKCE），`VITE_OPS_OIDC_CLIENT_ID` 只是公开标识符而非凭证。

## 手动重发

可以从 Actions 手动运行 `Deploy production`。工作流仍会查询目标 commit 的 check runs；该 commit 没有成功的 `Quality gate` 时会拒绝发布。

## Hono origin（`Deploy origin`）

origin 是 `data.maplayer.top`（`129.146.179.37`）上的 systemd 服务 `surreal-ck-hono`，工作目录 `/home/ubuntu/surreal_ck/current`，环境文件 `/etc/surreal-ck/server.env`（只在主机上，CI 不读取也不改写）。

`Deploy origin` 的步骤：确认 commit 通过 Quality gate → `git archive` 打包 → scp 到主机 → 执行 `scripts/deploy/origin-release.sh`：

1. 解包到 `releases/<sha7>-ci<run_id>`，`bunx pnpm@10.32.1 install --frozen-lockfile --prod`。
2. 备份 `server.env` 到 `~/surreal_ck/backups/env/`，再把 GitHub `production` Environment 中所有 `ORIGIN_ENV_<NAME>` secret 写成 `server.env` 的 `<NAME>=<值>`（只增改这些键，值必须单行，日志只打印键名）。
3. 发布代码里存在 `scripts/deploy/origin-pre-start.sh` 时：停掉 `surreal-ck-hono`（冻结 origin 写入），在新版本目录执行该钩子（`ORIGIN_ENV_FILE` 指向 `server.env`）。钩子必须幂等，用于一次性数据复制迁移等。
4. 原子切换 `current`，重启服务，轮询 `http://127.0.0.1:8080/health`。

钩子失败或 90 秒内不健康：恢复 `server.env` 备份和上一个 `current` 并重启，job 失败，Cloudflare 不会发布。CI 发布目录与 env 备份各保留最近 8 个，手工发布目录不动。

新增服务端环境变量：`gh secret set ORIGIN_ENV_<NAME> --env production`，下一次发布生效。不需要登录主机。

GitHub `production` Environment 额外配置：

- Secret `ORIGIN_SSH_KEY`：专用 ed25519 部署私钥（指纹 `SHA256:a6kDk9GJtawCz+OAP4dhJXQ2iAscwlyLDe/BRuo5gt0`），公钥以 `restrict` 选项登记在主机 `~ubuntu/.ssh/authorized_keys`。未配置时回退到 `SSH_KEY`。
- Variables：`ORIGIN_HOST=129.146.179.37`、`ORIGIN_USER=ubuntu`、`ORIGIN_KNOWN_HOSTS`（主机 ed25519 公钥，指纹 `SHA256:lXW+YzF2c6i7Lr8oziMi1Iy/sOj0zDhZR4DvPErvFFM`）。

手动重发某个已通过 CI 的 commit：从 Actions 运行 `Deploy origin` 并填入完整 SHA。回滚就是重发上一个 commit。

## 边界

Hono 启动时会执行 schema 与数据迁移，代码回滚不会回滚数据库。需要的新环境变量先用 `ORIGIN_ENV_*` secret 配好，需要停写执行的迁移放进 `origin-pre-start.sh`，再合入 main。SurrealDB 服务本身（`surrealdb.service`）与 root 凭证不由 CI 管理。
