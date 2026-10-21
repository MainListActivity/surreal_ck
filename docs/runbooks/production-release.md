# GitHub production release

生产发布由 GitHub Actions 串成一条不可绕过的链：

1. 变更通过 Pull Request 进入 `main`。
2. `Quality gate` 执行 lint、类型检查、测试、前端构建与 Docker 构建。
3. PR 合并后，`main` 上同一 commit 再次通过 `Quality gate`。
4. `Deploy production` 先调用 `Deploy origin`，把同一 commit 发布到 Hono origin 主机；origin 健康后才发布 Cloudflare。
5. 发布后探测应用、Hono `/health` 和营销站；任一失败都会把 production deployment 标记为失败。

G5 十七行映射、合入/CI、直接版本读数与未闭合项见 [`production-release-handoff.md`](production-release-handoff.md)。

当前 `Deploy production` 在 GitHub 上为 `disabled_manually`（workflow id `362937295`），合入 `main` 不会自动发布。启用条件与执行责任见「启用 `Deploy production`」。

**维护暂停（当前状态）**：前端补发已完成（`Frontend recovery` 运行 `39248415340` 成功，不重做）。origin 恢复补修尚未在主机实跑（G4 未验证）。origin 当前运行版本已于 2026-10-21T06:53:26Z 直接读回：`/api/ops/runtime-version` 返回 origin `state=known`、完整 SHA `50663e3a6c89ee9a61a25eddf334a682c445bee1`、`deploymentId=39153379368-1`；web 为同一 SHA、`deploymentId=39248415340-1`；canonical `/health` 为 `status=ok`、`surrealdb=up`。工具修补已合入 `main`（PR #205 合并提交 `5db5e18b`，2026-10-20 22:36:38Z），这次合入没有发布任何东西。在下列事项闭合前，不激活 origin、不启用自动发布，也不把新 `main` 当作生产 origin 的应用 SHA：

- 生产 origin 应用目标固定为 `50663e3a6c89ee9a61a25eddf334a682c445bee1`。
- 发布工具（`scripts/deploy`、`server/src/deploy` 与 `server/src/db/grant-revocation-*`）的修补以其 PR 头提交为准，合入后以合并提交为准。审批须引用同一个 SHA，并记录在 PR 描述与证据包 `report.md` 中。
- 工具代码已合入 `main`，两轮审批各绑定一个 SHA：PR #204 合并提交 `03d686728d1b9897583113e7529cd8211f268e85`（受审头 `f9182f4f161ffa8b8c8784ad0e634cbc139587d8`，2026-10-20T20:15:05Z）；PR #205 合并提交 `5db5e18bb4848cb49f100c7ea617731a5830e32a`（受审头 `45fd50b33c74985ae9371dfd1959361dba767ced`，2026-10-20T22:36:38Z，合并树 `5ba27ea8…` 与受审头逐字节一致，相对 base `03d68672` 只改 `server/src/deploy` 下两个测试与 harness 文件，+132/−24）。以 `main` 最新合并提交为工具 SHA，不把新 `main` 当作生产 origin 的应用 SHA（应用目标仍为 `50663e3a`）。本文档的修订提交只改文档：`git diff --stat 5db5e18b <PR 头> -- scripts server/src/deploy server/src/db` 应为空。
- 首次前向激活的前置项见「前向钩子（`origin-pre-start.sh`）」（F4）与「主机锁与陈旧锁回收」（F13）。
- 未验证项：G4（主机实跑前向故障与 scp 失败）未执行，本补修的结论只来自执行级测试，不来自主机结果。`39153839203` 等 `action_required` 派发的历史根因未经 API 证实。
- **工具 SHA 与后续文档/测试合并 SHA 分栏记录，互不代替**：工具实现为 PR #204 合并 `03d68672`、PR #205 合并 `5db5e18b`；之后仅文档与测试的修复合入时另记其合并 SHA，不能把任意最新 `main` 都写成被批准的工具版本。
- **N1（GM v30 第 6 项已给出定义，不再索要）**：`N1` = HTTP/2 framing error。来源父任务 3a v88（2026-10-19T12:55:33Z）；v95（2026-10-20T05:45:10Z）记录 9 次 HTTP/2 请求未复现，原因未知、未关闭；v97 明确保留 open。它与 `/health?query` 返回 SPA HTML、以及另一次登录连接超时分开记录，不混称根因。不因少量未复现关闭，也不授权改路由或放宽健康判定。
- **旧 LCA04_OPS 句柄（GM v30 第 7 项）**：QA 报告到期点 2026-10-20T23:53:47Z，经理 2026-10-21T02:13:05Z 读时已过该点；记为「已过代理报告 TTL、未执行 logout/未核全局 IdP 会话」，不冒充成功登出。`ops_logout` 只 drop 代理侧句柄，不等于全局 IdP 注销。
- PR #36、#55、#160 保持未合入。#36 头的 `origin-pre-start.sh` 与 main 字节相同，但其 `server/src/content/migrate-legacy-cli.ts` 与 main 不同（见「前向钩子」），不能以「钩子与 CLI 相同」为由合入或关闭。

公司项目元数据与本 runbook 有以下差异，以本 runbook 为准。更正由 GM 通过受控条目完成，工程不改元数据，也不用 owner 或 admin 凭证改写。

- `project.release` 写「合入即发布，不需要其他人批准」，同一元数据的 `notes` 却写「合入即触发发布，须先经上线申请批准」。两处互相矛盾。而且 GitHub 上 `Deploy production` 实际是 `disabled_manually`，合入 `main` 不会自动发布，与「合入即发布」的字面描述不符。维护暂停期间不启用自动发布；恢复自动发布的条件见「启用 `Deploy production`」。
- `project.rollback` 写「在 Actions 手动运行 Deploy origin」。`Deploy origin` 只能被调用，没有直接派发入口。实际入口是 `Deploy origin (manual)`，并须带 `approval_ref`。
- `project.rollback` 写「前端重跑该提交的 Deploy production」。`Deploy production` 仍为 `disabled_manually`，前端只能经 `Frontend recovery` 恢复。

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

Variables（2026-10-19 只读核对，前端 12 项全部存在，核对方法见「配置责任」）：

- `WEB_PAGES_PROJECT=surreal-ck-app`
- `MARKETING_PAGES_PROJECT=surreal-ck`
- `VITE_API_BASE_URL=https://l.maplayer.top`
- `VITE_SURREAL_URL=wss://data.maplayer.top/rpc`
- `VITE_OIDC_ISSUER=https://o.maplayer.top/t/ck`
- `VITE_OIDC_CLIENT_ID=b10df483-1cd4-4beb-8a01-92e8f4b3fdf4`
- `VITE_OIDC_REDIRECT_URI=https://l.maplayer.top/auth/callback`
- `VITE_OIDC_AUDIENCE=https://auth.maplayer.top`
- `VITE_OPS_OIDC_ISSUER=https://o.maplayer.top/t/ck`
- `VITE_OPS_OIDC_CLIENT_ID=7a021237-db69-42c9-8ff4-a8262647aab3`
- `VITE_OPS_OIDC_AUDIENCE=https://l.maplayer.top/api/ops/mcp`
- `VITE_OPS_API_BASE_URL=https://l.maplayer.top/api`

这些 `VITE_*` 值会进入公开的浏览器 bundle，因此只能放公开配置；OIDC client secret、SurrealDB root 密码、模型 key 等服务端凭证绝不能放在这里。ops SPA 是纯 public client（PKCE），`VITE_OPS_OIDC_CLIENT_ID` 只是公开标识符而非凭证。

## 手动重发

可以从 Actions 手动运行 `Deploy production`（启用之后）。工作流仍会查询目标 commit 的 check runs；该 commit 没有成功的 `Quality gate` 时会拒绝发布。

只重发 origin 时用 `Deploy origin (manual)`；只重发前端时用 `Frontend recovery`（见下文）。两者都只能从 `main` 派发，并与 `Deploy production` 共用发布锁。

## Hono origin（`Deploy origin`）

origin 是 `data.maplayer.top`（`129.146.179.37`）上的 systemd 服务 `surreal-ck-hono`，工作目录 `/home/ubuntu/surreal_ck/current`，环境文件 `/etc/surreal-ck/server.env`（只在主机上。CI 不直接读取或改写它；发布时 CI 只上传 env 增改件，由主机上的发布进程写入，见下文）。

`Deploy origin` 只能被调用（`workflow_call`），没有顶层 `workflow_dispatch`。两条入口执行同一份 `deploy-origin.yml`，并必须带 `approval_ref`：自动路径为 `deploy-production-<运行号>`，手动路径为运营批准号（见下文「手动发布 origin」）。

发布目标门禁（`scripts/deploy/release-target-gate.sh`）在任何上传之前执行：目标提交须是 `origin/main` 的祖先（compare 状态为 `behind` 或 `identical`），且 Quality gate 成功。回滚目标同样适用。未合入 main 的提交（例如 PR 头）在这里被拒绝，即使它的 Quality gate 是绿的。

发布分三段。**停服只发生在第 2 段的工作进程内，且只在上传、解包、依赖安装与全部门禁通过之后。**

1. **上传（CI，不停服）**：确认 commit 通过 Quality gate；`git archive` 打包并附加 `server/runtime-release.json`；scp 上传 env 增改件、发布包与 `origin-release.sh` 副本到 `/tmp`（文件名含 `<sha7>-ci<run_id>`）。上传失败在停服之前结束，旧版本继续运行。
2. **登记并分离执行（主机）**：`scripts/deploy/origin-release-ci.sh` 通过 SSH 调用 `--launch`。launch 只校验参数与上传件，登记状态并取锁，然后以 `nohup` 启动分离的工作进程并立即返回；SSH 断开不影响工作进程。工作进程依次执行：解包到 `releases/<sha7>-ci<run_id>`；回滚前提预检（登记的 `previous` 必须存在，并通过试用与分配来源门禁；纯静态，零服务与 env 变更，不通过即以 `refused` 结束）；`bunx pnpm@10.32.1 install --frozen-lockfile --prod`；撤销预检（`previous` 不含撤销过滤时，于新发布目录中读取撤销计数，计数非零或不可证明即以 `refused` 结束；零服务与 env 变更）；试用与分配来源门禁（纯静态、无副作用）；备份 `server.env` 到 `~/surreal_ck/backups/env/`；把 GitHub `production` Environment 中的 `ORIGIN_ENV_<NAME>` secret 逐行写成 `<NAME>=<值>`（只增改这些键，值必须单行，日志只打印键名；`UNSET` 哨兵表示删除该键）；撤销兼容门禁（见下）；若存在 `scripts/deploy/origin-pre-start.sh` 则停服执行该钩子（`ORIGIN_ENV_FILE` 指向 `server.env`，钩子必须幂等）；原子切换 `current`；重启服务；健康探测。
3. **收敛（CI 读取主机状态文件）**：CI 每 15 秒用 `--status` 读取状态，最多等 20 分钟。只有 `healthy` 才算成功。`interrupted`（工作进程已消失且未到终态）时 CI 在主机接受 `--recover` 之前每轮请求一次（忙或结果未知时下一轮重试），接受后只等待主机状态，不重复请求。任何终态失败都会让 job 失败。SSH 失败、超时或状态不可读**既不是成功，也不是回滚**：job 以「结果未知」失败，由运维读取主机状态后判定。

健康探测轮询 `http://127.0.0.1:8080/health` 最多 30 次，每次 curl 超时 5 秒、间隔 3 秒，合计约 240 秒（旧文档写的 90 秒已更正）。钩子失败或健康探测失败时，先过门禁，再恢复 `server.env` 备份与上一个 `current` 并重启，结果为 `rolled-back`，job 失败，Cloudflare 不会发布。CI 发布目录与 env 备份各保留最近 8 个，手工发布目录不动。

### 状态与处置

| 状态 | 含义 | 处置 |
| --- | --- | --- |
| `running` | 工作进程仍在执行 | 等待；超过截止时间时读取 `--status` 与 `--log` |
| `interrupted` | 工作进程已消失且未到终态（例如主机重启或进程被杀） | CI 自动请求 `--recover`（主机接受前每轮重试，接受后只等待）；恢复被拒时由运维处理 |
| `healthy` | 已切换并通过健康探测 | 成功 |
| `rolled-back` | 切换或健康失败后已恢复上一个版本并健康 | job 失败；先看日志中的失败原因 |
| `rollback-refused` | 回滚被门禁拒绝；已写入的 env 恢复为激活前备份，服务仍活跃（运行 `current` 当时指向的版本，可能是失败的新版本），回滚未执行 | 人工处置，优先向前修复（见「回滚被拒」） |
| `rollback-failed` | 回滚被门禁拒绝且服务已被本次激活停止（回滚不拉起被拒的 `previous`）；或回滚过程本身失败（切换、重启或健康探测失败）。服务停止时 origin 不可用 | 立即人工核查主机并报告 GM（见「回滚被拒」） |
| `refused` | 门禁在主机改动前拒绝（零服务与 env 变更）；或前向撤销门禁在停服后拒绝：先恢复 `server.env` 备份，再拉起原服务。拒绝后服务仍不活跃时不报 `refused`，以 `failed` 结束并要求人工核查 | 修复目标后用新运行重新发布 |
| `failed` | 主机未改动即结束（例如恢复时发现尚未开始切换）；或 env 恢复失败，服务保持停止 | 核查日志；env 恢复失败时先人工核查服务与 `backups/env/` 中的备份，再用新运行重新发布 |
| `absent` | 主机从未登记该激活 | CI 会重新登记 |

同一运行的重试沿用同一个 release id。终态不会被重新激活；要重新发布，用 `Deploy origin (manual)` 启动新的运行。

只读查看（不改变主机状态）：在 origin 上用 `main` 分支中 `scripts/deploy/origin-release.sh` 的副本执行 `--status <release-id>` 与 `--log <release-id>`。CI 在终态后会删除 `/tmp` 中的副本。

### 失败后的受控读回（F8）

以下情况 CI 以 exit 1 结束：终态失败（`rolled-back`、`rollback-refused`、`rollback-failed`、`failed`、`refused`）、截止时结果仍未知、恢复请求被拒。结束前 CI 先回读一次主机状态字段与日志末尾 60 行（只读；SSH 不通时输出 `status unavailable`），再报错。回读不改变退出码，也不把结果判为成功或回滚。`launch` 被拒（退出码 2）时 CI 直接以 exit 1 结束，不回读。

失败后的读回由运维执行，全部只读，不得重新激活：

1. 记录 CI 运行号、release id 与日志中最后一个 `state=`。
2. 用 `main` 侧的 `scripts/deploy/origin-release.sh` 副本执行 `--status <release-id>` 与 `--log <release-id>`。
3. 执行 `systemctl is-active surreal-ck-hono` 与 `/health`。
4. 结果写入证据包，并按下一节交接。

### 交接与暂存件（F10）

处理责任归该次发布的执行者，依据 GM v28 第 4 项：

- 明确失败，或轮询截止时，当轮即交接给受控运维做上述读回，不留给下一轮或自动处理。
- 不可达（SSH 失败、状态不可读）时，报告真实阻塞并保留未知结果。不得自动再次激活：不 `--launch`、不 `--recover`，也不整条重跑。
- 暂存件（远端工具副本、发布包、env 增改件）只有在确认终态或 `absent`、且没有工作进程使用之后，才能按 CI 的清理路径删除（`origin-release-ci.sh` 的 `cleanup`，只含终态与 `absent` 分支）。运行中或未知状态的件保留。不得按固定 TTL 盲删；代码中没有按时间删除暂存件的逻辑。
- CI 的远端删除失败会被忽略（`|| true`），CI 不报告残留。终态后，运维用只读的 `ls` 核对 `/tmp` 是否残留 `surreal_ck-<release-id>.tar.gz`、`surreal_ck-env-<release-id>` 与 `origin-release-<release-id>.sh`，残留件按上面的条件处理。
- 首次激活前须核对两点：暂存件在主机上的权限（应为 `0600`，只读 `stat -c %a`；工作流在 runner 以 `umask 077` 生成 env 增改件，主机侧未核实）；清理失败的处置（只能在满足上述条件时由运维手工删除，并记录）。

### 切换与回滚的可执行门禁

每次激活（正常发布、自动回滚、手动 Deploy origin 旧 sha）前，`origin-release.sh` 按序执行两道门禁。脚本副本来自 main 侧的 deploy tooling checkout（不是发布包），因此门禁代码始终是最新版，对旧目标一视同仁：

1. **试用来源门禁（LCA10，纯静态、无副作用）**：目标是正向契约判定，不是「没命中危险拼写」——必须同时满足：①`server/src/routes/workspaces.ts` 命中 `workspace-commercial-source-required` 关闭契约（LCA10 起公共创建入口一律 409 并指向显式入口）；②该文件不再发起任何 `createWorkspace` 供应调用（直接/间接来源赋值同拒）；③无 `planKey`/`sourceKind`/`resourceSource` 的 trial 键值字面量（含空白与引号变体）；④`server/src/routes/pro-trial.ts` 在场且为配置驱动实现（引用 `pro_trial_configuration`）、并被 `server/src/app.ts` 挂载（`createProTrialRoutes`）。目标树缺失/不可读/检查命令出错一律 fail-closed 拒绝。门禁在 env 增改与停服之前执行，拒绝时 `current`/`server.env`/服务零接触。
2. **撤销兼容门禁（LCA13）**：目标不含撤销过滤时，先停服冻结写入、静置排空 in-flight，再以受控检查器读 `_system` 撤销计数；有撤销或无法证明为空即拒绝。stop 失败时仅当 is-active 证明进程已死才采信冻结（进程已死与命令失败区分）。检查器的任何失败都按拒绝处理：非零退出、非整数计数、前导零、重复或缺失的计数行（F2，见 `server/src/deploy/origin-release-faults.test.ts`）。

门禁拒绝 = 发布/自动回滚失败：job 以明确原因退出，`current`、`server.env` 与服务状态保持不变——试用门禁在 env 写入之前拒绝所以本就零接触；env 键校验失败时先把 `server.env` 恢复成发布前备份。撤销门禁拒绝时同样先恢复 `server.env`，再拉起原服务：服务只能以激活前的配置启动，不得以被拒绝的增改启动。恢复失败会显式中止，服务保持停止，备份保留在 `backups/env/`，结果为 `failed`，须人工核查。之后等待人工处置，**向前修复优先**。自动回滚在「上一个 release 不满足门禁」（例如 LCA10/LCA13 之前的旧 origin）时会被拒绝，不会在人工处置前静默恢复旧入口。两道门禁的判定矩阵回归在 `server/src/deploy/origin-release-gate.test.ts`（逐字提取脚本函数在受控 harness 中仿真）。

新增服务端环境变量：`gh secret set ORIGIN_ENV_<NAME> --env production`，下一次发布生效。不需要登录主机。

G2 邀请开通的 IdP 凭证用 `ORIGIN_ENV_IDP_PROVISION_TOKEN`（进程名 `IDP_PROVISION_TOKEN`），轮换与红线见 [idp-provision-token.md](./idp-provision-token.md)。禁止配置人类 admin 密码。免部署轮换另需一次性配置 `ORIGIN_ENV_PLATFORM_SECRET_KEY`（进程名 `PLATFORM_SECRET_KEY`，`openssl rand -hex 32`），此后 provision token 轮换经 `POST /api/ops/idp-provision-token/rotate`，不再依赖发布。

GitHub `production` Environment 额外配置：

- Secret `ORIGIN_SSH_KEY`：专用 ed25519 部署私钥（指纹 `SHA256:a6kDk9GJtawCz+OAP4dhJXQ2iAscwlyLDe/BRuo5gt0`），公钥以 `restrict` 选项登记在主机 `~ubuntu/.ssh/authorized_keys`。未配置时回退到 `SSH_KEY`。
- Variables：`ORIGIN_HOST=129.146.179.37`、`ORIGIN_USER=ubuntu`、`ORIGIN_KNOWN_HOSTS`（主机 ed25519 公钥，指纹 `SHA256:lXW+YzF2c6i7Lr8oziMi1Iy/sOj0zDhZR4DvPErvFFM`）。

## 手动发布 origin

在 `main` 上从 Actions 运行 `Deploy origin (manual)`，填入完整 SHA 与 `approval_ref`（运营批准或回滚记录编号，写入运行名称与审计）。该运行只允许在 `main` 上启动（作业守卫）。合入后的首次探针验证见「dry_run 探针」。

回滚就是重发上一个已通过 Quality gate 的 commit，两道门禁仍会检查目标：目标是 LCA10/LCA13 之前的旧 origin 时会被拒绝激活（Actions 日志给出具体拒绝原因）。确需恢复旧语义 origin 时按门禁语义先做人工处置（停服评估、补齐配置或撤销资格），不要在脚本里找绕过参数——没有。

### 回滚的合法路径

1. 选定目标：上一个已通过 Quality gate、且已在 `main` 上的完整 SHA。登记的回滚目标可从 `origin-release.sh --status <release id>` 输出的 `previous=` 读取（只读）。
2. 在 `main` 上派发 `Deploy origin (manual)`：`sha` 填目标，`approval_ref` 填回滚记录编号，`dry_run` 保持 `false`。
3. 用「派发回执」核验这一次运行，再读取 `--status` 与 `--log`。
4. 只有终态为 `healthy` 才算回滚完成。其它终态见「回滚被拒」。

不得手工执行 `systemctl`、改写 `current` 或 `server.env` 来代替这条路径。

## 前向钩子（`origin-pre-start.sh`）

`scripts/deploy/origin-pre-start.sh` 只在转发激活中执行。发布包含该文件时，`run_release` 在全部门禁与 env 写入之后、切换 `current` 之前停服并执行它（`ORIGIN_ENV_FILE` 指向 `server.env`）。钩子失败即转入回滚：服务已停，回滚到登记的 `previous`，结果为 `rolled-back`；回滚本身失败则为 `rollback-failed`。回滚路径不执行钩子。

当前钩子执行 `migrate-legacy-cli.ts --writes-frozen`：先按版本执行内容库结构脚本，再把 `_system` 的平台内容复制到隔离内容库并校验。数据上只新增、不删除、不改写，重复执行结果一致。

迁移类型（PR 提交须与此一致）：数据只新增（复制缺失记录、v7 回填缺失的搜索 facet、标记 UPSERT），不删除或改写业务记录；版本门控的结构脚本含对既有定义的修改（`ALTER ... PERMISSIONS`、`ALTER FIELD ... FLEXIBLE`、`REMOVE EVENT IF EXISTS`、`DEFINE ACCESS OVERWRITE`），因此不得标为「只新增结构」。沿用既有钩子，使用 root 身份。生产当前 `platform_content_schema_version` 未核，待运营确认。

- **调用链**：`run_release` 在全部门禁与 env 写入之后停服（冻结），再执行 `scripts/deploy/origin-pre-start.sh`，即 `bun run --env-file=<server.env> src/content/migrate-legacy-cli.ts --writes-frozen`。
- **身份**：CLI 以 `server.env` 中的 `SURREAL_ROOT_USER` 与 `SURREAL_ROOT_PASS` 登录（即 root 凭证），在 `_system` 读取，在 `CONTENT_DATABASE` 写入。GM v30 第 3 项已确认：沿既有 root 平台维护身份作为 schema 与复制迁移的限定用途，不新建身份、不修改 root 凭证或权限，也不把 secret 读到员工侧。root 调用是受控例外；任何方案不得改变 `surrealdb.service`、root 凭证或生产数据目录。
- **冻结**：只依靠停服。CLI 要求显式传入 `--writes-frozen`，但不核实其它写入者是否已停止。
- **写入范围**：先对 `CONTENT_DATABASE` 执行 `ensurePlatformContentSchema`（先于标记检查）。它执行 `DEFINE DATABASE IF NOT EXISTS`，并按 `platform_content_schema_version` 只执行版本号大于当前值的脚本（`shared/sql/platform-content/`）。这些脚本含 `DEFINE`（新增结构）与对既有定义的修改（`ALTER ... PERMISSIONS`、`ALTER FIELD ... FLEXIBLE`、`REMOVE EVENT IF EXISTS`、`DEFINE ACCESS OVERWRITE`），不含对业务记录的 `DELETE` 或 `UPDATE`。版本 7 另含数据回填：对缺少搜索 facet 的已发布条目 `CREATE` 一条 `content_search_facet`。随后把 `_system` 中目标库缺失的记录 `CREATE` 或 `RELATE` 到 `CONTENT_DATABASE`；已存在的记录只做一致性断言，不改写。最后 `UPSERT` 标记 `content_migration_state:legacy`。迁移模块（`server/src/content/migrate-legacy.ts`）不含 `DELETE` 或 `UPDATE` 语句，也不写 `_system`。
- **幂等**：标记存在（来源为 `_system` 且 `verified_at` 非空）时输出 `already migrated` 并跳过复制。标记不存在时，上次中途失败留下的部分复制会在本次续做。
- **失败处置**：钩子失败按本节开头的规则转入回滚。回滚不删除已复制的内容，也不删除标记，回滚路径不执行钩子。
- **何时运行**：下一次从 `main` 执行的前向激活会执行该钩子。标记不存在时复制，标记已存在时跳过。生产库是否已有标记未经核实（见下文第 1 项）。合并 PR #36 不是这一项的前置条件。

只读核对的事实：

- 钩子在 main 上自 `7cdf330f`（PR #143，2026-10-04）起存在，`50663e3a` 与 `cfb870c3` 都包含它（blob `7164b64e`）。
- 运行 `39074722491`（`Deploy production`，成功，`cfb870c3`，2026-10-17）的 origin 日志依次显示 `stopping surreal-ck-hono for pre-start hook`、`[platform-content] already migrated`，然后切换到 `releases/cfb870c-ci39074722491`。该次激活执行过钩子，内容复制已处于完成状态。
- 这是本仓库可查到的最后一次有记录的成功 origin 激活。之后 origin 实际运行的 SHA 未经运营核定，不能据此假定。
- PR #36 的 `origin-pre-start.sh` 与 main 字节相同，但它的 `server/src/content/migrate-legacy-cli.ts` 不同：main 调用 `migrateLegacyPlatformContentIfNeeded`（已完成则输出 `already-migrated`），#36 直接调用 `migrateLegacyPlatformContent`。因此「钩子与 CLI 相同」不成立，#36 不得以此为由合入或关闭。

首次激活前须由 GM 决定（未闭合）：

1. 核对生产内容复制状态。claim 写「钩子在 PR #36 里，随 #29 一起合入发布」，并写「#29 尚未发布到 origin」，与上面的事实不一致。由运营核对，工程不直接访问生产数据。
2. 钩子使用的 CLI 版本：GM v30 第 3 项已选定 main 版 `migrateLegacyPlatformContentIfNeeded`（`5db5e18b` 及之后），保留 marker 判断与 `--writes-frozen` 守卫，不切换 PR #36 的无条件迁移入口，也不为此合入 #36/#55/#160。标记已存在时走 `already-migrated`；未核或无能力时不得冒称已迁移。
3. 停服窗口：GM v30 确认该「先停服再执行钩子」窗口是既有设计的一部分，但**本轮不批准实际停服窗口**；当前健康 origin 继续运行，也不把 CI 轮询 deadline 当作服务恢复 SLA。首次真实执行仍须另一次针对准确 head 的上线申请与受控维护窗口。
4. root 身份：GM v30 已接受为受控例外（见上文「身份」）；同时禁止改变 `surrealdb.service`、root 凭证或生产数据目录。首次实际执行仍须受控只读核对 marker、CLI/工具 SHA、写入范围与冻结准备。
5. **生产 marker 未核（能力缺口，CL04）**：`content_migration_state:legacy` 的 `source_database`、`verified_at` 及计数/版本元数据，需要内容库 `CONTENT_DATABASE` 的受控只读读取。截至本次收口，ops 工具面没有提供该对象的字段读取工具（无对应只读路由；`ops_query` 的客户会话按设计不能进入 `_system`/内容控制面，运营会话也不裸查 SQL）。因此记「首次激活前 marker 未核」，**首次激活保持阻断**；不得把「无权限/无工具」解释为 marker 不存在。所需精确缺口：项目 `surreal_ck`、环境 `production`、目标库 `CONTENT_DATABASE`、记录 `content_migration_state:legacy`、字段 `source_database`、`verified_at`、`summary`，另加版本元数据 `platform_content_schema_version:current` 的 `version`。

### 钩子调用链的边界回归（CL02，2026-10-21）

`server/src/content/migrate-legacy-cli-boundary.test.ts` 在隔离环境中执行真实入口，验证：

- `origin-pre-start.sh` 在发布目录的 `server/` 下以 `bun run --env-file=<server.env> src/content/migrate-legacy-cli.ts --writes-frozen` 调用 CLI；缺 `ORIGIN_ENV_FILE` 时在调用前失败。黑盒用例只校验 argv 与执行目录，不执行真实 bun 或 CLI。
- CLI 入口在缺少 `--writes-frozen` 时、建立任何连接之前拒绝，错误信息指明写入冻结。
- 数据夹具注入普通表记录、`cites_*` 关系记录与 v7 facet 回填输入，使真实复制循环执行：root 连接指向 `CONTENT_DATABASE`，来源连接指向 `_system` 且只执行 `SELECT`。
- 顺序断言：`ensurePlatformContentSchema`（`DEFINE DATABASE`）先于迁移 marker 检查与来源读取。
- 目标写入只落在内容迁移白名单表（含 `cites_*` 关系）、`content_migration_state:legacy` 标记（`source_database=_system`）与 schema 阶段的 `content_search_facet` 回填；迁移阶段不允许任何写形态的原始 query。
- 已迁移 marker（`verified_at` 非空）时幂等短路：不读来源、不复制、不重写 marker；未验证 marker 不算完成。
- 变异检测（红→绿）：
  - M7 复制循环的 `create` 改写到未授权表 `system_admin`：边界检查器判红；未变异副本判绿。
  - M8 把 `ensurePlatformContentSchema` 挪到迁移之后：顺序检查器判红；真实入口判绿。
  - 另有无守卫入口在已迁移状态下仍读来源并重写 marker、来源写入、异常数据库、迁移阶段写查询等用例。

结果（本地，2026-10-21）：新用例 13 pass / 0 fail，连续 3 次一致；既有 `migrate-legacy` 与 `src/deploy` 套件 357 pass / 0 fail。测试只使用隔离替身，不连接真实数据库、不启动 SurrealDB、不读取真实 `.env` 或凭证。它是执行级回归，不等于主机级 G3：主机上钩子以 root 连接真实内容库的行为仍未实测。

## 主机锁与陈旧锁回收（F13）

主机锁是 `/home/ubuntu/surreal_ck/deploy-state/lock`，由 `mkdir` 原子创建。目录内 `pid` 记录持有者，`release` 记录激活 id。

| 情况 | 结果 | 处置 |
| --- | --- | --- |
| 持有者进程存活 | `busy`（退出码 75） | 等待，不删除锁 |
| 持有者已死，激活未到终态 | `interrupted=<id>`（退出码 76） | 对该激活执行 `--recover <id>`（CI 会自动请求） |
| 持有者已死，且激活已终态、无状态文件，或即为 `--recover` 指定的激活 | 陈旧锁，回收并重建 | 无需处置 |
| 回收互斥 `lock.reclaim` 已存在，且持有者已死（或无 pid 超过 1 分钟） | `busy`（退出码 75），不自动删除 | 运维核查，见下 |

回收顺序：先 `mkdir lock.reclaim` 取得回收互斥，同一时刻只有一个回收者。互斥内重新核验锁（它可能已被释放或已被他人重建），再把陈旧锁原子移出为隔离名并删除，最后重建锁。回收互斥只由其持有者释放。

回收互斥的持有者已死（回收中途被终止）时，运维按以下步骤处理：

1. 确认 `lock.reclaim/pid` 指向的进程不存在，且没有 `origin-release.sh` 工作进程在运行（只读）。
2. 用 `--status` 读取 `lock/release` 中记录的激活，确认其状态（只读）。
3. 两项都确认后才手工删除 `lock.reclaim` 目录，并把两步的输出记入证据。不得为让发布通过而删除 `lock` 目录或改写状态文件。

F13 的并发与回收互斥由 `server/src/deploy/origin-release-faults.test.ts` 的 F13 用例覆盖，包括两个登记同时争抢同一陈旧锁（5 轮）时每轮恰好一个成功。

测试范围：该用例在本地 harness 中运行两个真实的 `--launch` 进程，`systemctl`、`sudo`、`bun`、`curl` 等为替身。主机上的 `mkdir` 与 `find -mmin` 行为未验证（G4）。F13 的修复与并发回归已由独立复核确认该段代码与测试满足（复核人非实现者；该复核对当时 head 的整体结论为 return，针对其它未闭合项）。GM v30 第 5 项接受「该已知竞态在代码与测试层闭合」，同时明确不能把旧 `6df8d938` 的整体 return 写成整体 accept。回收互斥持有者猝死时不自动豁免、以 `busy`(75) 要求受控运维核查的失败关闭设计保留，不强删锁；主机上的文件系统/`mkdir`/`find` 行为仍归 G4，未验证。

## 回滚被拒（`rollback-refused` / `rollback-failed`）

回滚门禁有三个拒绝位置，结果与主机状态不同：

| 位置 | 主机状态 | 终态 |
| --- | --- | --- |
| 回滚前提预检（依赖安装之前）：无登记的 `previous`（含主机尚无 `current` 的首次激活）、`previous` 目录缺失，或试用/分配来源不兼容 | 服务、`current`、env 均未改动 | `refused` |
| 撤销预检（依赖安装之后，停服之前） | 均未改动 | `refused` |
| 激活失败后的自动回滚：无 `previous`、试用或分配来源不兼容、撤销门禁拒绝 | 服务仍活跃则为 `rollback-refused`；本次激活已停服且服务非活跃则为 `rollback-failed` | 人工处置 |

没有登记的 `previous` 时，前向激活在依赖安装之前即以 `refused` 结束。这是有意的 fail closed：没有可回滚目标时不停服。因此，主机尚无 `current` 的首次部署会被拒绝，须由 GM 另行决定。

`rollback-refused` 时服务仍活跃，运行的是 `current` 指向的版本（通常是失败的新版本），并未被回滚。

撤销门禁拒绝回滚目标时，当前实现为 `hold`。被拒的 `previous` 缺少撤销过滤，且撤销计数非零或无法证明为零。回滚不拉起它，服务保持停止，结果为 `rollback-failed`。这样做是为了不重新放开已撤销的授权。**此时 origin 不可用，`/health` 失败。** 服务已被本次激活停止时，任何回滚门禁拒绝都以 `rollback-failed` 结束，服务同样保持停止。

`hold` 策略已由 GM v30 第 2 项确认为安全失败关闭策略（F1）：previous 预检与撤销预检不通过时，必须在停服与 env 写入之前拒绝；回滚被撤销门禁拒绝后先恢复 env，服务已停则保持停止并以 `rollback-failed` 非成功终态留痕，禁止拉起被拒 `previous`；恢复 env 失败同样不启动。可用性损失须告警交 GM，并走受审前向修复，不得伪报已回滚。该结论基于 main 的固定源码与已通过的回归；真实主机操作仍未验证，不授权故障注入。`rollback-failed` 且服务停止的状态仍按生产事故处理。

处置：

1. 只读核对：`--status <release id>`、`--log <release id>`、`systemctl is-active surreal-ck-hono` 与 `/health`。
2. 服务停止时立即报告 GM。不得手工 `systemctl start`、改写 `current` 或 `server.env`，也不得删除撤销记录或 `deploy-state`，除非 GM 书面批准并记录。
3. 优先向前修复：修复提交合入 `main` 后，用 `Deploy origin (manual)` 发布，`approval_ref` 填运营批准号。回滚目标须重新通过两道门禁。
4. 处置过程、命令输出与时间记入证据包。

## 派发回执（`receipt`）

派发 `Deploy origin (manual)` 或 `Frontend recovery` 后，用 `origin-verification.py receipt` 只读核验这一次运行。它只校验身份与结论，不派发，也不探测生产。运营本机需有已登录的 `gh`。该子命令自工具 PR 合入 `main` 之后可用，使用与 `main` 一致的脚本副本。

```bash
python3 origin-verification.py receipt --repo MainListActivity/surreal_ck \
  --run-id <run id> --attempt 1 --sha <派发的完整 SHA> --ref main \
  --workflow-path .github/workflows/deploy-origin-manual.yml \
  --timeout 1200 --interval 15
```

`Frontend recovery` 的 `--workflow-path` 为 `.github/workflows/release-frontend-recovery.yml`。

`--event` 默认为 `workflow_dispatch`。`Deploy production` 的自动运行由 `workflow_run` 触发，核验时须用 `--event workflow_run --workflow-path .github/workflows/deploy-production.yml`；事件不符即拒绝。`--job-name` 以运行内显示的名称为准：被调用的复合工作流在调用方运行内显示为「调用方作业 / 被调用作业」，例如 `Hono origin / Hono origin (systemd)`。

退出码：

- `0`：运行已完成，结论 `success`，作业可完整读取且全部 `success`。
- `2`：拒绝。运行号、尝试号、提交、分支、事件或工作流路径与派发不符；结论为 `failure`、`cancelled` 或 `action_required`（含 0 作业）；或某个作业未成功。
- `3`：尚未判定。排队、进行中、接口临时失败，或等待超时。`3` 不是通过，不得据此继续。

回执不是发布结果，发布结果仍以 `--status`、`--log`、健康探测与终态为准。历史样本：运行 `39153839203` 为 `action_required` 且 0 作业，回执退出码为 `2`，不得当作已部署。

成功样本：运行 `39074722491`（`Deploy production`，`workflow_run`，提交 `cfb870c3`，2026-10-17，三个作业全部 `success`）以 `--event workflow_run` 与上述父路径核验，退出码为 `0`。以默认事件核验同一运行，或以 `deploy-origin.yml` 为路径核验，退出码均为 `2`。

## 前端定向恢复（`Frontend recovery`）

用于 origin 已运行目标提交、但前端需要回到该提交的场景。它只把 web、marketing、ops 与 edge 发布到 Cloudflare。**不调用 `Deploy origin`，不 SSH，不 SCP，不停服，不切换 `current`，不改 `server.env`，不改动 origin。**

只能从 `main` 手动派发（`workflow_dispatch`），输入如下：

- `sha`：目标 commit（完整 SHA）。必须已合入 `main`，`Quality gate` 成功，并且等于本次运行中运营核定的 origin 运行 SHA。
- `evidence_pr`：承载运营核定评论的 PR 编号。
- `approval_ref`：fa 运营 accept 审计编号。必须与评论中的 `fa_audit_ref` 逐字相同。
- `dry_run`、`hold_seconds`：只供探针使用，见「dry_run 探针」。正式发布时 `dry_run=false`。

### 运行流程

整条运行持有顶层发布锁 `production-release`，直到发布结束或失败结束。其它入口在此期间排队（见「发布互斥」）。

1. **`validate`**（不使用 environment 与 secrets，仅以只读的 `GITHUB_TOKEN` 读取 PR 与 check runs）：运行 `scripts/deploy/frontend-recovery-gate.sh`。检查输入格式、`RELEASE_APPROVER_LOGINS` 已配置、`sha` 已合入 `main`、证据 PR 存在（只读 PR 元数据，不读评论）、`Quality gate` 成功、origin 健康探测 `status=ok` 且 `surrealdb=up`。origin 运行 SHA 不在这一步读取，因为 CI 读不到它。
2. **`deploy`**（`environment: production`，只有这一作业使用 secrets）：
   1. 拒绝重跑：`GITHUB_RUN_ATTEMPT` 不为 `1` 即失败。
   2. 复核 `Quality gate` 成功，校验 production 配置。
   3. 检出 `sha` 并安装依赖、构建 web、marketing 与 ops。此时没有生产写入。
   4. **生成 barrier**：`origin-verification.py barrier` 在构建之后、任何生产写入之前生成 barrier，并写入作业摘要。barrier 绑定仓库、run id、run attempt、workflow ref、受审 tooling 的完整 SHA（即本运行的 `GITHUB_SHA`）、目标 `sha`、生成时间与随机 nonce。同一份 barrier 紧接着以 artifact `origin-barrier-<run id>-<run attempt>` 上传（同名不覆盖，保留 1 天），运营在作业仍运行时经 `fetch` 取回。
   5. **有界等待**：最多 20 分钟，等待一条绑定该 barrier 的运营核定评论。CI 只以本作业生成的 barrier 比对，不读取 artifact。超时、无证据、证据不合格或 API 持续失败，作业都会失败，锁随之释放。
   6. **写入前复核**：`verify` 再次校验评论，并检查 origin `/health`。任一失败都在第一次 Cloudflare 写入之前停止。
   7. **写入**：Hono edge Worker，然后 Pages 应用（含 `/ops/`），最后 marketing 站点。
   8. **发布后检查**（`Verify production` 步骤，按顺序）：`https://l.maplayer.top/` 返回 HTTP 200；`https://l.maplayer.top/health` 返回 HTTP 200，且 JSON 中 `status` 为 `ok`、`surrealdb` 为 `up`；`https://l.maplayer.top/runtime-version.json` 的 `sha` 为本次 `sha`、`deploymentId` 为本次运行的 `<run id>-<run attempt>`（每 10 秒轮询，最多 30 次）；`https://www.maplayer.top/` 返回 HTTP 200；`https://l.maplayer.top/ops/` 页面包含「运营控制台」。

### 运营核定证据

barrier 生成之后，运营（执行人）按以下顺序操作。工具名与调用方式以 `sck call ops_info '{}'` 返回为准。执行人是持有效公司租约的原正式部署任务执行者（本次维护期间为任务 `3a9b0b3c-da89-4090-a0ea-a442b1608a7e`）。

取回 barrier 的命令对应下面的第 1 步。发布作业生成 barrier 后，同一份内容以 artifact `origin-barrier-<run id>-<run attempt>` 上传，作业仍在运行时即可取回。取回使用运营本机已登录的 `gh`（只读），不需要 production 环境或任何 secret。脚本须与运行提交一致，即 barrier 的 `tooling_sha`：

```bash
# 取得运行提交（需先 git fetch）；fetch 子命令自引入它的工具 PR 合入之后的版本起可用
gh api repos/MainListActivity/surreal_ck/actions/runs/<run id> --jq .head_sha
git -C <本地仓库> show <head_sha>:scripts/deploy/origin-verification.py > origin-verification.py

# 作业仍为 in_progress 时取回；--timeout 为 0 时只查一次
python3 origin-verification.py fetch --repo MainListActivity/surreal_ck \
  --run-id <run id> --target <派发的 sha> --out barrier.json \
  --timeout 600 --interval 15
```

`fetch` 逐项核验：运行是 `Frontend recovery` 的第一次尝试；artifact 未过期，挂在本运行上，提交与运行一致；压缩包内只有 `origin-barrier.json`，大小在界内，且为规范字节；barrier 的仓库、run id、attempt、工作流引用与 tooling SHA 都与本运行一致，目标与 `--target` 相同；生成时间不早于运行开始，距今不超过 20 分钟。退出码：`0` 取回并通过；`2` 校验拒绝（重名、错误运行、篡改、过期、非 JSON 等），停止，不发表评论，整条重新派发；新的正式派发须经原正式部署任务的受控流程，不得因 `2` 自动重新派发；`3` 尚不可读，或等待 / 重试预算耗尽（含持续的临时 GitHub 接口错误），或运行已结束却没有 artifact；`1` 脚本校验的用法错误、写入 `--out` 失败，或未被重试分支捕获的意外错误。临时接口错误不返回 `1`，预算内重试，耗尽后返回 `3`。命令行参数缺失、拼写错误或类型不合法时，解析器（argparse）以 `2` 退出，这不是校验拒绝，也未执行取回，核对命令后重试即可，不据此重新派发。`fetch` 不构成证据：绑定评论仍须由白名单审批人发表，CI 的等待与校验仍只以本作业生成的 barrier 为准。

对 `3` 再取的边界：只有原运行仍有效（仍为第一次尝试），且 barrier 仍在 20 分钟有效窗内（以作业摘要中的 `generated_at` 计），才可用同一命令再取，每次仍受 `--timeout` 预算约束，不得无限重取。运行已结束却没有 artifact 时（退出码 `3`），之后不会再出现 barrier，不得重取；本次运行即不可用，停止，不发表评论，整条重新派发须经原正式部署任务的受控流程另行决定。

1. 按上面的命令取回 barrier，保存为本地 `barrier.json`，不修改。确认 `target_sha` 与派发的 `sha` 相同，`run_attempt` 为 `1`。作业摘要中的 JSON 只供人工对照；`fetch` 退出码为 `2` 时，不得改用摘要内容发表评论。
2. `ops_info`：确认运维工具可用。
3. `ops_operator_login`：登录运营会话。
4. `ops_request`：以 GET 请求 `/api/ops/runtime-version`。记下 origin 实际运行的完整 SHA，以及核定时间（UTC，`YYYY-MM-DDTHH:MM:SSZ`）。
5. `ops_health`：确认 `status=ok` 且 `surrealdb=up`。
6. `ops_logout`。
7. 若 origin 运行 SHA 不等于 `barrier.target_sha`，或状态未知，或健康异常，停止，不发表评论，并报告 GM。不得为了让发布通过而发表旧目标的证据。
8. 在 barrier 之后、20 分钟等待窗口内发表评论。脚本取自 barrier 的 `tooling_sha`（需先 `git fetch`），不使用本地未审副本。运营机器时钟须与标准时间同步：核定时间早于 barrier，或超前当前时间 60 秒以上，都会被拒绝。

```bash
# 取得与 barrier 同一版本的脚本，并确认发表账号（必须是 RELEASE_APPROVER_LOGINS 中的成员，当前为 MainListActivity）
git -C <本地仓库> show <tooling_sha>:scripts/deploy/origin-verification.py > origin-verification.py
gh api user --jq .login

# 本地预览正文，不发表
python3 origin-verification.py render --barrier barrier.json \
  --origin-sha <origin 运行的完整 SHA> --origin-verified-at <核定时间 UTC> \
  --ops-task-id <执行采样的公司任务 ID> --fa-audit-ref <fa 审计编号>

# 发表并回读校验
python3 origin-verification.py post --barrier barrier.json \
  --origin-sha <origin 运行的完整 SHA> --origin-verified-at <核定时间 UTC> \
  --ops-task-id <执行采样的公司任务 ID> --fa-audit-ref <fa 审计编号> \
  --pr <evidence_pr> --approvers MainListActivity --approval-ref <approval_ref>
```

9. `post` 退出码：`0` 表示评论已发表且回读通过；`2` 表示评论不符合要求；`3` 表示未识别到绑定评论；`1` 表示用法或接口错误。退出码为 `2` 或 `3` 时，不编辑或删除已发表的评论，停止并整条重新派发。退出码为 `1` 时，先到证据 PR 确认是否已有评论：已有则按前一句处理，没有则可修正后重试同一条命令。
10. 评论一经发表，不得编辑。编辑后 `updated_at` 与 `created_at` 不同，CI 会拒绝。

### 校验规则

CI 的 `wait` 与写入前的 `verify` 按下表判定。任一项失败都使发布失败：

| 情况 | 结果 |
| --- | --- |
| 评论不含本次 barrier 的 nonce，或不在证据 PR 上 | 不计入，超时后失败 |
| 作者不在 `RELEASE_APPROVER_LOGINS` 中 | 忽略，不计入 |
| 绑定评论被编辑过 | 拒绝 |
| 绑定评论不是恰好一个 `origin-verification-v1` 代码块，或字段缺失、多余、重复 | 拒绝 |
| 仓库、run id、run attempt、workflow ref、tooling SHA、目标、生成时间或 nonce 与本次 barrier 不符 | 拒绝 |
| `origin_sha` 不等于目标 `sha`（例如 origin 运行 B，请求 A） | 拒绝 |
| 核定时间早于 barrier、晚于评论创建时间，或超前当前时间 60 秒以上 | 拒绝 |
| 核定时间距校验时刻超过 30 分钟 | 拒绝，须重新采样并整条重新派发 |
| `fa_audit_ref` 与 `approval_ref` 不同 | 拒绝 |
| 同一 barrier 有两条绑定评论 | 拒绝（歧义） |
| 整条运行被重跑（run attempt 大于 1） | 拒绝；barrier 不会生成 |

运营取回 barrier 的 `fetch` 不在上表之内，其规则见「运营核定证据」；CI 的等待与校验不读取 artifact。

## 发布互斥

三个入口共用顶层并发组 `production-release`，不取消进行中的运行（`cancel-in-progress: false`）：

- `Deploy production`（`deploy-production.yml`）
- `Deploy origin (manual)`（`deploy-origin-manual.yml`）
- `Frontend recovery`（`release-frontend-recovery.yml`）

任一入口运行时，其余入口排队。origin 变更与前端发布因此不会并发。`Frontend recovery` 从派发起持锁，直到前端写入结束（或失败结束）。`Deploy production` 的前端阶段紧跟同一运行中刚发布的 origin，两者使用同一个 `sha`，且不使用 barrier。

被 `Deploy origin (manual)` 与 `Deploy production` 调用的 `deploy-origin.yml` 只保留 job 级组 `production-origin`，不设顶层组，否则会与调用方嵌套死锁。它只有 `workflow_call`，没有直接派发入口，因此不存在绕过外层锁的入口。

按 GitHub 并发组语义，同一组同时只保留一个排队中的运行：后排队的运行会取代先排队的运行，先排队的被取消。因此不要同时派发多个入口；被取消的运行须整条重新派发。

**锁的边界。** 锁只约束经本仓库工作流的变更。CI 不读取 origin 运行 SHA（公开入口没有，`/api/ops/runtime-version` 需要运营会话），也不持有运营凭证。锁内的版本事实由运营通过运维工具采样并发表评论（见「前端定向恢复」）。运营或发布作业若发现健康变化、版本状态未知，或疑似有人手工改动主机，即停止并报告 GM。

## dry_run 探针（合入后必跑）

`Frontend recovery` 与 `Deploy origin (manual)` 都有 `dry_run` 输入（默认 `false`）。`dry_run=true` 时只运行 `probe` 作业：它不使用 `environment`，不引用 `secrets`，不生成 barrier，不等待批准，不发布。它只校验 `hold_seconds`（0 至 900 的整数）并持有 `production-release` 这么多秒。两个入口读取的输入不同：`Deploy origin (manual)` 的探针把 `sha` 写入作业日志（`approval_ref` 只出现在运行名称中）；`Frontend recovery` 的探针只读取 `hold_seconds`。两个入口的必填输入仍须按表单填写，但探针不依据它们做任何判断。

合入 `main` 后按顺序执行，并记录运行号：

1. `Deploy origin (manual)`，`dry_run=true`，`hold_seconds=0`：探针产生作业，说明派发可用。
2. `Frontend recovery`，`dry_run=true`，`hold_seconds=0`：同上，并确认 `validate` 与 `deploy` 被跳过。
3. 排队验证：先派发 `Frontend recovery`（`dry_run=true`，`hold_seconds=300`），运行中再派发 `Deploy origin (manual)`（`dry_run=true`）。第二个运行应显示为等待，在第一个结束后才开始。若它被取消而不是等待，记录两个运行号并报告 GM。

探针只证明派发、互斥与权限边界。它不证明 barrier、评论校验或真实发布可用，这些只能在真实运行中验证。

## 运行中可读性探针（artifact 通道）

`.github/workflows/frontend-barrier-artifact-probe.yml` 验证 barrier artifact 能否在作业仍运行时经 `gh` 取回。合入前它只存在于本线分支 `lane/c11970f4-frontend-barrier-artifact`，由推送到该分支触发，hold 为 600 秒。合入默认分支后，可手动派发并输入 `hold_seconds`（60 至 900 的整数，默认 600）。

- 不使用 `environment`，不引用 secrets，权限只读，不写 Cloudflare、origin 或产品数据，不加入 `production-release` 组。
- 作业生成合成 barrier（工作流引用指向探针文件，目标为探针自身的提交），以与正式发布相同的名称上传，在作业内回读并逐字节比对，然后保持 `hold_seconds` 秒。
- 工程在作业仍为 `in_progress` 时，用 `fetch --workflow-path .github/workflows/frontend-barrier-artifact-probe.yml --target <探针提交>` 取回，并与作业摘要中的 sha256 对照。
- 合成 barrier 不能用于正式评论：正式的 `fetch` 因工作流路径与发布运行不符而拒绝它；即使手工发表，绑定评论也与发布运行的 barrier 不符，CI 不会接受。

探针只证明传输：artifact 能在运行中被取回，且与生成内容逐字节一致。它不证明评论校验或真实发布。

## 前端部分失败的恢复路径

- 入口：只有 `Frontend recovery`，整条重新派发。不 SSH，不停服，不切换 `current`，不改 `server.env`，origin 不变。
- 版本匹配：`sha` 必须等于本次锁内核定的 origin 运行 SHA，发布作业强制执行。前端只能恢复到 origin 当前运行的提交。origin 不在目标提交时，前端不能发布到该提交；先经 `Deploy origin (manual)` 处理 origin，再恢复前端。
- 责任：派发人负责整条重新派发；运营负责锁内核定与发表评论；两者都记录在本次恢复的证据中。
- 部分失败（例如 web 已发布而 marketing 失败，或发布后检查失败）：不得只重跑失败的作业，重跑会被拒绝。运营在新的 barrier 下重新核定 origin 并发表新评论，以同一 `sha` 整条重新派发。
- 诊断顺序：`validate` 日志（准入门禁各项）→ `deploy` 日志（停在哪一步：barrier、等待、复核、哪个 `wrangler` 命令、哪项发布后检查）→ `https://l.maplayer.top/runtime-version.json`、`/health`、`https://www.maplayer.top/`、`https://l.maplayer.top/ops/` → Cloudflare Pages 部署记录。
- 人工回退 Cloudflare Pages 到上一个部署不属于恢复路径。若已人工改动，视为版本未知，随后用新运行把前端对齐到 origin 运行的 SHA。
- 不得用 `Deploy production` 代替前端恢复：它先发布 origin，且当前处于禁用状态。

## 启用 `Deploy production`

`Deploy production` 保持 `disabled_manually`，直到以下条件全部成立：

1. 修复 PR 经独立评审后，由原执行人合入 `main`，且 `main` 上合并提交的 `Quality gate` 成功。
2. `Deploy origin (manual)` 与 `Frontend recovery` 的 `dry_run=true` 探针已在 `main` 上运行，排队验证结论已记录。
3. fa 运营重新批准的审计编号已记录。
4. 原正式部署任务的执行人已完成前端补发：锁内 barrier 之后的运营核定与 `Frontend recovery` 发布，并经 QA 复核双面版本、`/health`、登录、`www` 与 `/ops/`。
5. 下方配置表中的变量与 `RELEASE_APPROVER_LOGINS` 已核对。
6. 本补修的工具 PR 经另一位工程师复核、`Quality gate` 成功，并合入 `main`。证据记录 PR 头 SHA 与合并提交 SHA。当前状态（2026-10-20）：已完成。PR #204（受审头 `f9182f4f`，合并 `03d68672`）经独立复核 595869 与运营 1c767dab 批准合入；PR #205（受审头 `45fd50b3`，合并 `5db5e18b`）经独立复核 2ddb0a70 与运营 27ff8ef6 批准合入；`main` 上合并提交的 Quality gate 运行 `39509366116` 成功。本项闭合只覆盖工具修补合入，不闭合本表其它条件。
7. G4（主机实跑的前向故障与 scp 失败）由 GM 决定：在批准的维护窗口执行并记录，或书面接受其未执行为残余风险。两种结论都写入启用证据。当前状态（2026-10-21）：未执行。GM v30 第 1 项裁定：本轮不安排生产前向故障/scp 失败注入，不为补证据停健康服务；接受「仅工具合入/收口」阶段 G4 未实跑的残余验证边界，但**不能据此满足恢复自动发布条件或宣称主机安全**。G4 未证实仍由父任务 3a 的合法真实激活/受控只读诊断计划处理；部署 QA 不得以执行本链明令禁止的生产故障注入作为前置。
8. F1（`hold`）与 F4（钩子首次激活、CLI 版本与 root 身份）须由 GM 决定并记录，见「回滚被拒」与「前向钩子」。当前状态（2026-10-21）：F1 已确认（GM v30 第 2 项，安全失败关闭，代码与 runbook 一致）；F4 已确定使用 main 版 `migrateLegacyPlatformContentIfNeeded`、root 维护身份为受控例外，但**本轮不批准停服窗口与实际执行**，生产 marker 未核（能力缺口），首次激活仍阻断。
9. `N1` 的定义与状态：GM v30 第 6 项已定义 `N1` = HTTP/2 framing error（来源父 3a v88；v95 记录 9 次未复现、原因未知；v97 保留 open）。与 `/health?query` 返回 SPA HTML、另一次登录连接超时分开记录。当前状态：未关闭，原因未知；不因少量未复现关闭，也不授权改路由或放宽健康判定。
10. F13（陈旧锁回收）当前状态（2026-10-20）：修复为回收互斥 `lock.reclaim` 加原子移出再删除（引入于 `f53d080c`，其后锁代码未变，`git log -S lock.reclaim -- scripts/deploy/origin-release.sh` 止于该提交）。并发回归（两个登记争抢同一陈旧锁，5 轮）在 `origin-release-faults.test.ts` 的 F13 用例。独立复核记录 `review-c501-6df8d938`（复核人 engineering-factory-droid-c501ef，非实现者）对该项的结论为「代码与测试满足，未经主机验证」，但该复核对该 head 的整体结论为 return（针对当时其它未闭合项，不是锁代码）。GM v30 第 5 项已书面接受该已知竞态在代码与测试层闭合，同时明确不得把旧 `6df8d938` 的整体 return 写成整体 accept；回收互斥持有者猝死时 `busy`(75) 要求受控运维核查的失败关闭设计保留；主机行为仍归 G4。
11. 「交接与暂存件（F10）」中的首次激活准备（暂存件权限核对与清理失败处置）已完成并记录。
12. **旧 LCA04_OPS 句柄**：已过代理报告 TTL（到期 2026-10-20T23:53:47Z），未执行 logout、未核全局 IdP 会话；如实记录，不冒充已登出。`ops_logout` 仅 drop 代理侧句柄。
13. **本收口链的工具/文档/测试合并 SHA 分记**：文档与测试补修另开 PR，合入后记录其合并 SHA 与 `main` CI；它**不**替代 PR #204/#205 的工具 SHA，也不把新 `main` 当作生产 origin 的应用 SHA。

执行人是原正式部署任务 `3a9b0b3c-da89-4090-a0ea-a442b1608a7e` 当次持有效租约的工程执行者。修复 PR 的实现者不负责启用，也不由仓库所有者代为启用。

```bash
gh workflow enable deploy-production.yml --repo MainListActivity/surreal_ck
gh api repos/MainListActivity/surreal_ck/actions/workflows/deploy-production.yml --jq .state   # 必须为 active
```

记录启用时间与读回结果。

QA 与启用的先后：原执行人可以先提交前端补发阶段的 QA。QA 核对上述条件 1 至 4，并在验收中写明「只待已批准的启用与读回」。原执行人启用后再提交最终 QA 验收，附 `active` 读回与完整收口证据。

### 收口模板

每次启用或恢复尝试（含中途停止）的收口证据须逐项记录，缺项即视为未收口：

1. 工作流状态：`Deploy production`、`Deploy origin (manual)`、`Frontend recovery` 的当时状态读回（命令、时间戳），写明 `disabled_manually` 或 `active`；合并时间窗内的发布入口运行列表（分页取全）。
2. 版本事实：origin 运行的完整 SHA（运营经 `/api/ops/runtime-version` 采样）与采样时间；web 的 `runtime-version.json` 的 `sha` 与 `deploymentId`；本次合并提交与受审头 SHA。工具 SHA 与应用 SHA 分记，历史样本不冒称本轮读数。
3. 事故状态与未验证项：本次涉及的主机终态（`healthy`、`rolled-back`、`refused`、`rollback-refused`、`rollback-failed`、`failed` 等）；仍未验证项清单（如 G4、F1/F4 决定、N1、`39153839203` 根因）与各项负责人。
4. 回滚路径：本次变更的受审撤回方式（`git revert -m 1 <合并提交>` 或 `Deploy origin (manual)` 的目标 SHA 与 `approval_ref`）及前提。
5. 值班接手：遗留会话与句柄（例如 ops 登录会话的登录与到期时间）、暂存件残留核对结果、下一班须继续的事项。

禁止为了启用而追补未经批准的 `main`，或重跑健康的 origin。条件不满足时保持 `disabled_manually`，并向 GM 报告具体缺口。

## 配置责任

2026-10-19 只读核对，名称分页读取，不读取 secret 的值：

| 配置 | 位置 | 状态 | 缺失时 |
| --- | --- | --- | --- |
| `RELEASE_APPROVER_LOGINS` | 仓库变量（Actions variables，非 environment） | 存在，值为 `MainListActivity`（GM 设置） | 准入门禁与发布作业拒绝（fail closed） |
| 前端 12 项变量：`WEB_PAGES_PROJECT`、`MARKETING_PAGES_PROJECT`、`VITE_*`（含 `VITE_OPS_*`） | `production` Environment 变量 | 12 项全部存在 | 配置校验失败，不发布 |
| `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | `production` Environment secrets | 存在 | 配置校验失败，不发布 |
| `ORIGIN_HOST`、`ORIGIN_USER`、`ORIGIN_KNOWN_HOSTS`，secret `ORIGIN_SSH_KEY` | `production` Environment | 存在 | origin 发布失败；前端恢复不使用 |

核对方法（API 默认只返回前 10 项，必须分页读取，否则会把后页的变量误判为缺失）：

```bash
gh api --paginate "repos/MainListActivity/surreal_ck/environments/production/variables?per_page=100" --jq '.variables[].name'
gh api repos/MainListActivity/surreal_ck/actions/variables/RELEASE_APPROVER_LOGINS --jq .value
```

变量名单只说明配置存在。实际是否可发布，仍以入口的预检和运行结果为准。

## 事故恢复顺序（维护暂停期间）

1. `Deploy production` 保持 `disabled_manually`。前端恢复不会启用它。
2. 修复 PR 经独立评审后，由原执行人合入 `main`，并确认合并提交的 `Quality gate` 成功。
3. 在 `main` 上运行 `Deploy origin (manual)` 与 `Frontend recovery` 的 `dry_run=true` 探针，记录排队验证结论。
4. 运营在锁内核定 origin 运行 SHA，并在证据 PR（本次维护期间为 PR #199）上发表评论。
5. 以已核定的 SHA 运行 `Frontend recovery`（`dry_run=false`）。任何失败都整条重新派发，见「前端部分失败的恢复路径」。
6. 独立 QA 复核 origin 与前端的版本、`/health`、登录、`www` 与 `/ops/`。
7. 前端恢复与 QA 证据齐全，且 fa 运营重新批准后，原执行人启用 `Deploy production` 并读回 `active`。

本次恢复的初次目标是 GM 指定的 `50663e3a6c89ee9a61a25eddf334a682c445bee1`。origin 实际运行的不是它，或状态未知时即停止，不发布旧目标。

## 已知问题：action_required

运行 39153839203 被 GitHub 记为 `action_required`，没有作业。其 check suite `106101394646` 的检查项数为 0（只读核对）。`deploy-origin.yml` 的直接派发（`workflow_dispatch`）自 2026-09-29 起共 20 次全部记为 `action_required`，没有作业，API 不给出原因（2026-10-18 只读核对）；同一文件经 `Deploy production` 的 `workflow_call` 调用、使用同一 `production` 环境时仍成功（如运行 `39074722491`，2026-10-17）。**根因尚未证实。**

当前手动入口为 `deploy-origin-manual.yml`（顶层只有 `workflow_dispatch`，调用可复用的 `deploy-origin.yml`）。`Frontend recovery` 也有 `dry_run` 探针。合入 `main` 后先运行一次 `dry_run=true`：

- 探针产生作业：派发本身可用。它不证明环境或 secret 没有问题，也不证明发布可用。
- 探针仍为 `action_required` 且无作业：记录运行号并报告 GM。不推断根因，不盲目重复派发，不绕过环境保护或必需检查。

## 边界

Hono 启动时会执行 schema 与数据迁移，代码回滚不会回滚数据库。需要的新环境变量先用 `ORIGIN_ENV_*` secret 配好，需要停写执行的迁移放进 `origin-pre-start.sh`，再合入 main。SurrealDB 服务本身（`surrealdb.service`）与 root 凭证不由 CI 管理。

### 各次运行所用的 SurrealDB 构建

- 2026-10-21 收口链的 Quality gate 运行（本 PR 头）使用与既有仓库标准一致的 Linux runner 与公司 fork 候选制品；具体 run 号与合并 SHA 记录在交接文档与 PR 描述中。

- Quality gate（CI）安装公司 fork 的候选制品 `sck-3.3.0-native-quota.1-candidate.105`（`MainListActivity/surrealdb`），sha256 固定并校验。集成测试使用此构建。
- 本机检查器日志 `checker-live-local-surreal-v3.3-nightly.log` 对应 v3.3 nightly 本地构建，不等同于 CI 或生产所用构建。
- 生产主机 `surrealdb.service` 所用的构建未记录。启用前由运营只读记录（`surreal version` 的输出与服务的可执行文件路径）。
