# GitHub production release

生产发布由 GitHub Actions 串成一条不可绕过的链：

1. 变更通过 Pull Request 进入 `main`。
2. `Quality gate` 执行 lint、类型检查、测试、前端构建与 Docker 构建。
3. PR 合并后，`main` 上同一 commit 再次通过 `Quality gate`。
4. `Deploy production` 先调用 `Deploy origin`，把同一 commit 发布到 Hono origin 主机；origin 健康后才发布 Cloudflare。
5. 发布后探测应用、Hono `/health` 和营销站；任一失败都会把 production deployment 标记为失败。

当前 `Deploy production` 在 GitHub 上为 `disabled_manually`（workflow id `362937295`），合入 `main` 不会自动发布。启用条件与执行责任见「启用 `Deploy production`」。

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

在 `main` 上从 Actions 运行 `Deploy origin (manual)`，填入完整 SHA 与 `approval_ref`（运营批准或回滚记录编号，写入运行名称与审计）。该运行只允许在 `main` 上启动（作业守卫）。合入后的首次探针验证见「dry_run 探针」。

回滚就是重发上一个已通过 Quality gate 的 commit，两道门禁仍会检查目标：目标是 LCA10/LCA13 之前的旧 origin 时会被拒绝激活（Actions 日志给出具体拒绝原因）。确需恢复旧语义 origin 时按门禁语义先做人工处置（停服评估、补齐配置或撤销资格），不要在脚本里找绕过参数——没有。

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
   4. **生成 barrier**：`origin-verification.py barrier` 在构建之后、任何生产写入之前生成 barrier，并写入作业摘要。barrier 绑定仓库、run id、run attempt、workflow ref、受审 tooling 的完整 SHA（即本运行的 `GITHUB_SHA`）、目标 `sha`、生成时间与随机 nonce。
   5. **有界等待**：最多 20 分钟，等待一条绑定该 barrier 的运营核定评论。超时、无证据、证据不合格或 API 持续失败，作业都会失败，锁随之释放。
   6. **写入前复核**：`verify` 再次校验评论，并检查 origin `/health`。任一失败都在第一次 Cloudflare 写入之前停止。
   7. **写入**：Hono edge Worker，然后 Pages 应用（含 `/ops/`），最后 marketing 站点。
   8. **发布后检查**：`https://l.maplayer.top/runtime-version.json` 显示本次 `sha` 与 `deploymentId`；`/health`、`https://www.maplayer.top/` 与 `https://l.maplayer.top/ops/` 页面包含「运营控制台」。

### 运营核定证据

barrier 生成之后，运营（执行人）按以下顺序操作。工具名与调用方式以 `sck call ops_info '{}'` 返回为准。执行人是持有效公司租约的原正式部署任务执行者（本次维护期间为任务 `3a9b0b3c-da89-4090-a0ea-a442b1608a7e`）。

1. 从本次运行的作业摘要复制 barrier JSON，保存为本地 `barrier.json`，不修改。确认 `target_sha` 与派发的 `sha` 相同，`run_attempt` 为 `1`。
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

`Frontend recovery` 与 `Deploy origin (manual)` 都有 `dry_run` 输入（默认 `false`）。`dry_run=true` 时只运行 `probe` 作业：它不使用 `environment`，不引用 `secrets`，不生成 barrier，不等待批准，不发布。它只校验 `hold_seconds`（0 至 900 的整数）并持有 `production-release` 这么多秒。其它必填输入仍须填写，探针不读取它们。

合入 `main` 后按顺序执行，并记录运行号：

1. `Deploy origin (manual)`，`dry_run=true`，`hold_seconds=0`：探针产生作业，说明派发可用。
2. `Frontend recovery`，`dry_run=true`，`hold_seconds=0`：同上，并确认 `validate` 与 `deploy` 被跳过。
3. 排队验证：先派发 `Frontend recovery`（`dry_run=true`，`hold_seconds=300`），运行中再派发 `Deploy origin (manual)`（`dry_run=true`）。第二个运行应显示为等待，在第一个结束后才开始。若它被取消而不是等待，记录两个运行号并报告 GM。

探针只证明派发、互斥与权限边界。它不证明 barrier、评论校验或真实发布可用，这些只能在真实运行中验证。

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

执行人是原正式部署任务 `3a9b0b3c-da89-4090-a0ea-a442b1608a7e` 当次持有效租约的工程执行者。修复 PR 的实现者不负责启用，也不由仓库所有者代为启用。

```bash
gh workflow enable deploy-production.yml --repo MainListActivity/surreal_ck
gh api repos/MainListActivity/surreal_ck/actions/workflows/deploy-production.yml --jq .state   # 必须为 active
```

记录启用时间与读回结果。

QA 与启用的先后：原执行人可以先提交前端补发阶段的 QA。QA 核对上述条件 1 至 4，并在验收中写明「只待已批准的启用与读回」。原执行人启用后再提交最终 QA 验收，附 `active` 读回与完整收口证据。

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
