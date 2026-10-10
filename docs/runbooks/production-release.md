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

`Deploy origin` 的步骤：确认 commit 通过 Quality gate → `git archive` 打包 → scp 到主机 → 由 `scripts/deploy/origin-release-runner.sh` 在主机上启动一次**与 SSH 会话解耦**的发布：

- `runner launch` 以 `nohup+setsid`（stdin=/dev/null、无控制终端）派生分离的 `run` 子进程执行 `origin-release.sh`；CI 的 SSH 会话在任意时刻死亡（断连、job 中止）都不会打断远端——健康检查与失败回滚在主机上无人值守收尾。
- 每次发布的 job 目录是 `~/surreal_ck/deploy-jobs/<release_id>/`（release_id 形如 `<sha7>-ci<run_id>-a<attempt>`）：`result` 是原子写入的终态权威（`success`/`failed:<rc>`/`failed:runner_*`），`output.log` 留存发布全程输出供审计，`run.pid` 供存活探测。终态以 result 为准，不是以 SSH 会话为准。
- job 由 `mkdir` 原子认领：同一 release_id 的重发/并发调用 attach 到同一次发布而不重入；`deploy-jobs/release.lock` 的 flock 保证同一时刻只有一个发布在执行（CI 轮询超时放弃后新发布不会与残留 job 重叠）。CI job 目录只保留最近 16 个。
- CI 侧 `launch` 失败重试 5 次，随后每 10s 轮询 `runner status`（中途 SSH 失败不计为远端失败），15 分钟未出终态按失败处理并提示远端可能仍在跑；出终态后回取 `runner log` 进 Actions 日志。
- `origin-release.sh` 在 env 备份完成后武装 `HUP/INT/TERM` trap：进入任何改变主机状态的窗口（env 增改/撤销门禁停服/pre-start 停服/切换/健康检查）后被终止，按发布失败走完整 `rollback`；`rollback` 执行期间忽略同类信号，回滚不被二次打断。

分离的 `origin-release.sh` 在主机上依次执行：

1. 解包到 `releases/<release_id>`，`bunx pnpm@10.32.1 install --frozen-lockfile --prod`。
2. 试用来源门禁（见下）：纯静态、无副作用，在任何主机状态变更之前拒绝目标。
3. 备份 `server.env` 到 `~/surreal_ck/backups/env/`，再把 GitHub `production` Environment 中所有 `ORIGIN_ENV_<NAME>` secret 写成 `server.env` 的 `<NAME>=<值>`（只增改这些键，值必须单行，日志只打印键名；非法键或后续门禁拒绝会先把 env 恢复成备份再退出）。此后到达的 `HUP/INT/TERM` 按「发布中断」回滚。
4. 撤销兼容门禁（见下）：目标不含撤销过滤时停服冻结并查 `_system`，拒绝则恢复 env 备份并拉回服务后退出。
5. 发布代码里存在 `scripts/deploy/origin-pre-start.sh` 时：停掉 `surreal-ck-hono`（冻结 origin 写入），在新版本目录执行该钩子（`ORIGIN_ENV_FILE` 指向 `server.env`）。钩子必须幂等，用于一次性数据复制迁移等。
6. 原子切换 `current`，重启服务，轮询 `http://127.0.0.1:8080/health`。

钩子失败或 90 秒内不健康：先过门禁再恢复 `server.env` 备份和上一个 `current` 并重启，job 失败（终态 `failed:1`），Cloudflare 不会发布。CI 发布目录与 env 备份各保留最近 8 个，手工发布目录不动。断连收尾语义由 `scripts/deploy/origin-release-runner.test.sh` 演练（launch 会话在 pre-start/healthy 窗口被 SIGHUP+KILL 后，run 仍完成发布或回滚并写终态），接入 Quality gate。

### 切换与回滚的可执行门禁

每次激活（正常发布、自动回滚、手动 Deploy origin 旧 sha）前，`origin-release.sh` 按序执行两道门禁。脚本副本来自 main 侧的 deploy tooling checkout（不是发布包），因此门禁代码始终是最新版，对旧目标一视同仁：

1. **试用来源门禁（LCA10，纯静态、无副作用）**：目标是正向契约判定，不是「没命中危险拼写」——必须同时满足：①`server/src/routes/workspaces.ts` 命中 `workspace-commercial-source-required` 关闭契约（LCA10 起公共创建入口一律 409 并指向显式入口）；②该文件不再发起任何 `createWorkspace` 供应调用（直接/间接来源赋值同拒）；③无 `planKey`/`sourceKind`/`resourceSource` 的 trial 键值字面量（含空白与引号变体）；④`server/src/routes/pro-trial.ts` 在场且为配置驱动实现（引用 `pro_trial_configuration`）、并被 `server/src/app.ts` 挂载（`createProTrialRoutes`）。目标树缺失/不可读/检查命令出错一律 fail-closed 拒绝。门禁在 env 增改与停服之前执行，拒绝时 `current`/`server.env`/服务零接触。
2. **撤销兼容门禁（LCA13）**：目标不含撤销过滤时，先停服冻结写入、静置排空 in-flight，再以受控检查器读 `_system` 撤销计数；有撤销或无法证明为空即拒绝。stop 失败时仅当 is-active 证明进程已死才采信冻结（进程已死与命令失败区分）。

门禁拒绝 = 发布/自动回滚失败：job 以明确原因退出，`current`、`server.env` 与服务状态保持不变——试用门禁在 env 写入之前拒绝所以本就零接触；env 键校验失败或撤销门禁拒绝时先把 `server.env` 恢复成发布前备份（恢复失败会显式中止、备份保留在 `backups/env/`），撤销门禁同时把服务拉回运行——等待人工处置，**向前修复优先**。自动回滚在「上一个 release 不满足门禁」（例如 LCA10/LCA13 之前的旧 origin）时会被拒绝，不会在人工处置前静默恢复旧入口。两道门禁的判定矩阵回归在 `server/src/deploy/origin-release-gate.test.ts`（逐字提取脚本函数在受控 harness 中仿真）。

新增服务端环境变量：`gh secret set ORIGIN_ENV_<NAME> --env production`，下一次发布生效。不需要登录主机。

G2 邀请开通的 IdP 凭证用 `ORIGIN_ENV_IDP_PROVISION_TOKEN`（进程名 `IDP_PROVISION_TOKEN`），轮换与红线见 [idp-provision-token.md](./idp-provision-token.md)。禁止配置人类 admin 密码。免部署轮换另需一次性配置 `ORIGIN_ENV_PLATFORM_SECRET_KEY`（进程名 `PLATFORM_SECRET_KEY`，`openssl rand -hex 32`），此后 provision token 轮换经 `POST /api/ops/idp-provision-token/rotate`，不再依赖发布。

GitHub `production` Environment 额外配置：

- Secret `ORIGIN_SSH_KEY`：专用 ed25519 部署私钥（指纹 `SHA256:a6kDk9GJtawCz+OAP4dhJXQ2iAscwlyLDe/BRuo5gt0`），公钥以 `restrict` 选项登记在主机 `~ubuntu/.ssh/authorized_keys`。未配置时回退到 `SSH_KEY`。
- Variables：`ORIGIN_HOST=129.146.179.37`、`ORIGIN_USER=ubuntu`、`ORIGIN_KNOWN_HOSTS`（主机 ed25519 公钥，指纹 `SHA256:lXW+YzF2c6i7Lr8oziMi1Iy/sOj0zDhZR4DvPErvFFM`）。

手动重发某个已通过 CI 的 commit：从 Actions 运行 `Deploy origin` 并填入完整 SHA。回滚就是重发上一个 commit，但两道门禁仍会检查目标：目标是 LCA10/LCA13 之前的旧 origin 时会被拒绝激活（Actions 日志给出具体拒绝原因）。确需恢复旧语义 origin 时按门禁语义先做人工处置（停服评估、补齐配置或撤销资格），不要在脚本里找绕过参数——没有。

## 边界

Hono 启动时会执行 schema 与数据迁移，代码回滚不会回滚数据库。需要的新环境变量先用 `ORIGIN_ENV_*` secret 配好，需要停写执行的迁移放进 `origin-pre-start.sh`，再合入 main。SurrealDB 服务本身（`surrealdb.service`）与 root 凭证不由 CI 管理。
