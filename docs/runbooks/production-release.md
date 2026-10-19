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

只重发 origin 时用 `Deploy origin (manual)`；只重发前端时用 `Frontend recovery`（见下文）。

## Hono origin（`Deploy origin`）

origin 是 `data.maplayer.top`（`129.146.179.37`）上的 systemd 服务 `surreal-ck-hono`，工作目录 `/home/ubuntu/surreal_ck/current`，环境文件 `/etc/surreal-ck/server.env`（只在主机上，CI 不读取也不改写）。

`Deploy origin` 只能被调用（`workflow_call`），没有顶层 `workflow_dispatch`。两条入口执行同一份 `deploy-origin.yml`，并必须带 `approval_ref`：自动路径为 `deploy-production-<运行号>`，手动路径为运营批准号（见下文「手动发布 origin」）。

发布目标门禁（`scripts/deploy/release-target-gate.sh`）在任何上传之前执行：目标提交须是 `origin/main` 的祖先（compare 状态为 `behind` 或 `identical`），且 Quality gate 成功。回滚目标同样适用。未合入 main 的提交（例如 PR 头）在这里被拒绝，即使它的 Quality gate 是绿的。

发布分三段。**停服只发生在第 2 段的工作进程内，且只在上传、解包、依赖安装与全部门禁通过之后。**

1. **上传（CI，不停服）**：确认 commit 通过 Quality gate；`git archive` 打包并附加 `server/runtime-release.json`；scp 上传 env 增改件、发布包与 `origin-release.sh` 副本到 `/tmp`（文件名含 `<sha7>-ci<run_id>`）。上传失败在停服之前结束，旧版本继续运行。
2. **登记并分离执行（主机）**：`scripts/deploy/origin-release-ci.sh` 通过 SSH 调用 `--launch`。launch 只校验参数与上传件，登记状态并取锁，然后以 `nohup` 启动分离的工作进程并立即返回；SSH 断开不影响工作进程。工作进程依次执行：解包到 `releases/<sha7>-ci<run_id>`；`bunx pnpm@10.32.1 install --frozen-lockfile --prod`；试用与分配来源门禁（纯静态、无副作用）；备份 `server.env` 到 `~/surreal_ck/backups/env/`；把 GitHub `production` Environment 中的 `ORIGIN_ENV_<NAME>` secret 逐行写成 `<NAME>=<值>`（只增改这些键，值必须单行，日志只打印键名；`UNSET` 哨兵表示删除该键）；撤销兼容门禁（见下）；若存在 `scripts/deploy/origin-pre-start.sh` 则停服执行该钩子（`ORIGIN_ENV_FILE` 指向 `server.env`，钩子必须幂等）；原子切换 `current`；重启服务；健康探测。
3. **收敛（CI 读取主机状态文件）**：CI 每 15 秒用 `--status` 读取状态，最多等 20 分钟。只有 `healthy` 才算成功。`interrupted`（工作进程已消失且未到终态）时 CI 在主机接受 `--recover` 之前每轮请求一次（忙或结果未知时下一轮重试），接受后只等待主机状态，不重复请求。任何终态失败都会让 job 失败。SSH 失败、超时或状态不可读**既不是成功，也不是回滚**：job 以「结果未知」失败，由运维读取主机状态后判定。

健康探测轮询 `http://127.0.0.1:8080/health` 最多 30 次，每次 curl 超时 5 秒、间隔 3 秒，合计约 240 秒（旧文档写的 90 秒已更正）。钩子失败或健康探测失败时，先过门禁，再恢复 `server.env` 备份与上一个 `current` 并重启，结果为 `rolled-back`，job 失败，Cloudflare 不会发布。CI 发布目录与 env 备份各保留最近 8 个，手工发布目录不动。

### 状态与处置

| 状态 | 含义 | 处置 |
| --- | --- | --- |
| `running` | 工作进程仍在执行 | 等待；超过截止时间时读取 `--status` 与 `--log` |
| `interrupted` | 工作进程已消失且未到终态（例如主机重启或进程被杀） | CI 自动请求 `--recover`（主机接受前每轮重试，接受后只等待）；恢复被拒时由运维处理 |
| `healthy` | 已切换并通过健康探测 | 成功 |
| `rolled-back` | 切换或健康失败后已恢复上一个版本并健康 | job 失败；先看日志中的失败原因 |
| `rollback-refused` | 上一个版本未通过门禁，回滚被拒，当前版本保持原状 | 人工处置，优先向前修复 |
| `rollback-failed` | 回滚过程本身失败 | 立即人工核查主机 |
| `refused` | 门禁在切换前拒绝（已恢复 env） | 修复目标后用新运行重新发布 |
| `failed` | 主机未改动即结束（例如恢复时发现尚未开始切换） | 核查日志，用新运行重新发布 |
| `absent` | 主机从未登记该激活 | CI 会重新登记 |

同一运行的重试沿用同一个 release id。终态不会被重新激活；要重新发布，用 `Deploy origin (manual)` 启动新的运行。

只读查看（不改变主机状态）：在 origin 上用 `main` 分支中 `scripts/deploy/origin-release.sh` 的副本执行 `--status <release-id>` 与 `--log <release-id>`。CI 在终态后会删除 `/tmp` 中的副本。

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

## 手动发布 origin

在 `main` 上从 Actions 运行 `Deploy origin (manual)`，填入完整 SHA 与 `approval_ref`（运营批准或回滚记录编号，写入运行名称与审计）。该运行只允许在 `main` 上启动（作业守卫）。

回滚就是重发上一个已通过 Quality gate 的 commit，两道门禁仍会检查目标：目标是 LCA10/LCA13 之前的旧 origin 时会被拒绝激活（Actions 日志给出具体拒绝原因）。确需恢复旧语义 origin 时按门禁语义先做人工处置（停服评估、补齐配置或撤销资格），不要在脚本里找绕过参数——没有。

## 前端定向恢复（`Frontend recovery`）

用于 origin 健康、但前端需要回到已验证 commit 的场景。它只把 web、marketing、ops 与 edge 发布到 Cloudflare。**不调用 `Deploy origin`，不 SSH，不 SCP，不停服，不切换 `current`，不改 `server.env`。**

只能从默认分支（`main`）手动触发，输入如下：

- `sha`：目标 commit（完整 SHA），必须已合入 `main` 且 Quality gate 成功。
- `origin_sha`：运营只读核定的 origin 运行 SHA（完整 SHA），必须等于 `sha`。`/api/ops/runtime-version` 需要运营会话，CI 无法读取，因此由运营核定后填写。
- `origin_verified_at`：核定时间（UTC，格式 `YYYY-MM-DDTHH:MM:SSZ`），核定后 30 分钟内有效。
- `approval_ref`：运营批准评论的数字 ID（本仓库 issue 评论）。评论作者须在仓库变量 `RELEASE_APPROVER_LOGINS` 中（大小写不敏感），正文须逐字包含目标 `sha` 与 `origin_verified_at`，且创建时间不早于核定时间。

准入门禁（`scripts/deploy/frontend-recovery-gate.sh`）检查：`sha` 等于 `origin_sha`；核定时间新鲜；目标已合入 `main`；Quality gate 成功；运营批准评论可核查（作者授权、正文绑定 sha 与核定时间、创建不早于核定时间）；origin 健康探测返回 `status=ok` 且 `surrealdb=up`。任何一项不成立都拒绝发布前端。

核定时效在两处检查，窗口相同：`validate` 运行准入门禁；`deploy` 作业开头再检查一次。核定时间须距运行时刻不超过 30 分钟，且不得超前当前时间 60 秒以上；超时即 `deploy` 失败。

**失败后不得只重跑失败的作业。** `validate` 或 `deploy` 任一失败，都须整条工作流重新派发（Run workflow）。核定已超过 30 分钟时，先由运营重新只读核定 origin，填写新的 `origin_sha` 与 `origin_verified_at`，并在批准评论中写明新的核定时间。整条重新派发会让 `validate` 重新跑全部准入检查（含 origin 健康探测），`deploy` 只在它之后执行。即使仍在 30 分钟窗口内，单独重跑 `deploy` 也不允许：它会跳过 `validate` 的健康探测与批准复核。代码只拦截过期的重跑，窗口内的单独重跑靠本条操作规程禁止。

`RELEASE_APPROVER_LOGINS` 由仓库所有者配置（`gh variable set RELEASE_APPROVER_LOGINS --repo MainListActivity/surreal_ck --body '<登录名,…>'`）。**未配置前前端恢复一律拒绝**（fail closed）。本页不写死任何登录名。

发布后检查：`https://l.maplayer.top/runtime-version.json` 必须显示本次 `sha` 与运行的 `deploymentId`；同时检查 `/health`、应用首页、营销站与 `/ops/` 标题。runtime-version 只证明当前 Pages 部署是目标构建，不证明某个浏览器仍缓存的旧 JS 已刷新。

## 发布互斥、dry_run 与配置责任

**互斥。** `Deploy production`、`Deploy origin (manual)`、`Frontend recovery` 共用顶层并发组 `production-release`（不取消进行中的运行）。任一入口运行时其余入口排队，origin 变更与前端发布因此不会并发。被调用的 `deploy-origin.yml` 只保留 job 级组 `production-origin`，不设顶层组，否则会与调用方嵌套死锁。

按 GitHub 并发组语义，同一组同时只保留一个排队中的运行：后排队的运行会取代先排队的运行，先排队的被取消。因此不要同时派发多个入口；被取消的运行须整条重新派发。

**已知缺口（经理裁定前）。** `deploy` 作业在锁内不复核 origin 运行 SHA：CI 无法读取（`/api/ops/runtime-version` 需要运营会话，`/health` 不含 SHA）。核定时效只在作业开头按 30 分钟窗口检查。因此运营核定 origin 之后、前端恢复结束之前，若 origin 被变更，门禁不会发现。在此期间不得放行 origin 变更；必须放行时，重新核定 origin 并整条重新派发前端恢复。

**dry_run 探针（合入后必跑）。** `Frontend recovery` 与 `Deploy origin (manual)` 都有 `dry_run` 输入（默认 `false`）。`dry_run=true` 时只运行 `probe` 作业：它不使用 `environment`，不引用 `secrets`，只校验 `hold_seconds`（0 至 900 的整数）并持有发布锁这么多秒。其它必填输入仍须填写，探针不读取它们。

合入 `main` 后按顺序执行，并记录运行号：

1. `Deploy origin (manual)`，`dry_run=true`，`hold_seconds=0`：probe 作业产生即说明派发可用。仍为 `action_required` 且没有作业的，按上文「已知问题」处理。
2. `Frontend recovery`，`dry_run=true`，`hold_seconds=0`：同上，并确认 `validate` 与 `deploy` 被跳过。
3. 排队验证：先派发 `Frontend recovery`（`dry_run=true`，`hold_seconds=300`），运行中再派发 `Deploy origin (manual)`（`dry_run=true`）。第二个运行应显示为等待，在第一个结束后才开始。若它被取消而不是等待，记录两个运行号并报告仓库所有者。

探针只证明派发、互斥与权限边界，不证明发布可用。

**前端部分失败的恢复路径。**

- 入口：只有 `Frontend recovery`。不 SSH，不停服，不切换 `current`，不改 `server.env`，origin 不变。
- 版本匹配：`sha` 必须等于运营核定的 `origin_sha`（准入门禁强制）。前端只能恢复到 origin 当前运行的提交。origin 不在目标提交时，门禁拒绝前端发布；先经 `Deploy origin (manual)` 处理 origin，再恢复前端。
- 责任：运营只读核定 origin 运行 SHA，写入 `origin_sha` 与 `origin_verified_at`，并在 issue 评论中批准；派发人负责整条重新派发。
- 部分失败（例如 web 已发布而 marketing 失败）：不得只重跑 `deploy` 作业。运营重新核定 origin，以同一 `sha` 整条重新派发，批准评论中写明新的核定时间。
- 诊断顺序：validate 日志（准入门禁各项）；deploy 日志（哪一个 `wrangler pages deploy` 或探测失败）；`https://l.maplayer.top/runtime-version.json` 与 `/health`；Cloudflare Pages 部署记录。
- 不得用 `Deploy production` 代替前端恢复：它先发布 origin，且当前处于禁用状态。

**启用 `Deploy production` 的条件与执行责任。** 在以下条件全部成立前，`Deploy production` 保持 `disabled_manually`：

1. 修复 PR 合入 `main`，`main` 上同一提交的 `Quality gate` 通过。
2. 两个入口的 `dry_run` 运行均已完成，排队验证结论已记录。
3. 前端恢复与独立 QA 证据齐全。
4. 运营批准已记录，批准人在 `RELEASE_APPROVER_LOGINS` 中。
5. 下方配置责任表中的变量已全部配置。

谁执行启用**待经理裁定**，本页不指定。启用后用 `gh workflow list --all` 核对状态，并记录启用时间与运行号。

**配置责任表。** 只列名称，值见上文各节。其余变量本次未逐项核对。

| 配置 | 位置 | 责任人 | 2026-10-18 只读核对 | 缺失时 |
| --- | --- | --- | --- | --- |
| `RELEASE_APPROVER_LOGINS` | 仓库变量 | 仓库所有者 | 为空 | 前端准入门禁拒绝 |
| `WEB_PAGES_PROJECT` | `production` Environment 变量 | 仓库所有者 | 缺失 | 前端 `deploy` 与 `Deploy production` 的配置校验失败 |
| `VITE_SURREAL_URL` | `production` Environment 变量 | 仓库所有者 | 缺失 | 同上 |
| `VITE_OPS_OIDC_ISSUER` | `production` Environment 变量 | 仓库所有者 | 缺失 | 同上 |
| `VITE_OPS_OIDC_CLIENT_ID` | `production` Environment 变量 | 仓库所有者 | 缺失 | 同上 |
| `VITE_OPS_OIDC_AUDIENCE` | `production` Environment 变量 | 仓库所有者 | 缺失 | 同上 |

## 事故恢复顺序（维护暂停期间）

1. `Deploy production` 保持禁用（`disabled_manually`），前端恢复不会启用它。
2. 工具 PR 经独立评审并获运营批准后合并到 `main`，确认 `main` 上的 Quality gate 通过。
3. 运营只读核定 origin 运行 SHA，并填写 `origin_sha` 与 `origin_verified_at`。
4. 从 `main` 运行 `Frontend recovery`，目标为已核定的 SHA。任何失败都整条重新派发，不只重跑失败的作业（见上文）。
5. 运营只读确认 origin 与 web 的 SHA、`www` 与 `/ops/` 正常；独立 QA 复核。
6. 只有前端恢复与 QA 证据齐全、且运营批准之后，才重新启用 `Deploy production`，并核对启用后的状态。

## 已知问题：action_required

运行 39153839203 被 GitHub 记为 `action_required`，没有作业，也没有检查项。核对结果（只读，2026-10-18）：`deploy-origin.yml` 的直接派发（`workflow_dispatch`）自 2026-09-29 起共 20 次全部记为 `action_required`，没有作业，没有检查项，API 不给出原因；最后一次成功的直接派发是 2026-09-28。同一文件经 `Deploy production` 的 `workflow_call` 调用、使用同一 `production` 环境时仍成功（如运行 `39074722491`，2026-10-17）。**根因尚未证实。**

当前手动入口为 `deploy-origin-manual.yml`（顶层只有 `workflow_dispatch`，调用可复用的 `deploy-origin.yml`），并新增 `dry_run` 探针：`dry_run=true` 时只运行 `probe` 作业，它不使用 `environment` 也不使用 `secrets`。**合入 `main` 后须先运行一次 `dry_run=true`：** 探针产生作业，说明派发本身可用，问题在可复用工作流的环境或密钥；探针仍为 `action_required` 且无作业，则记录运行号，由仓库所有者检查 Actions 设置（环境保护规则、分支策略），不要绕过 owner-only 保护或必需检查。

## 边界

Hono 启动时会执行 schema 与数据迁移，代码回滚不会回滚数据库。需要的新环境变量先用 `ORIGIN_ENV_*` secret 配好，需要停写执行的迁移放进 `origin-pre-start.sh`，再合入 main。SurrealDB 服务本身（`surrealdb.service`）与 root 凭证不由 CI 管理。
