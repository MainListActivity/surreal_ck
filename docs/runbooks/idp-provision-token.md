# IdP provision token（可吊销机器凭证）

运营代办开通（`POST /api/ops/invitations`）通过 ma_hono admin API 开通用户时，使用 **可吊销 service principal**，不使用人类 admin 密码。

## 红线

- **禁止**把 ma_hono 人类 admin 密码写入 GitHub secrets、`server.env`、应用配置或 CI。
- 若有人要求配置 `ORIGIN_ENV_IDP_ADMIN_EMAIL` / `ORIGIN_ENV_IDP_ADMIN_PASSWORD`（或任何等价密码注入），视为红线：拒绝，并向经理 `report_blocker to=gm`。
- Token 明文不得进入仓库、PR、日志、审计 payload、任务证据或聊天。

## 有效 token 的解析顺序（每次调用解析，无进程内缓存）

1. `_system.platform_secret:idp_provision_token` 密封行存在 → 解封即现行值（轮换结果，来源 `store`）。
2. 无密封行 → 回退环境变量 `IDP_PROVISION_TOKEN`（来源 `env`，仅作初始装配 / 应急兜底）。
3. 两者皆无 → `invite-idp-not-configured`（HTTP 503，fail closed，不触达 IdP）。

密封行存在但解封失败（`PLATFORM_SECRET_KEY` 错配或密文损坏）时错误上抛，
**不静默回退 env**，避免已被轮换顶替的旧值复活。密封行中的 token 被 IdP
吊销后同样不回退：邀请报 `idp-admin-*` 错误即暴露，运营须再次轮换。

## 进程配置

| 环境 | 说明 |
| --- | --- |
| `PLATFORM_SECRET_KEY` | 密封仓主密钥（64 hex / 32 bytes）；生产由 `ORIGIN_ENV_PLATFORM_SECRET_KEY` 经 CI 写入 `server.env`。缺省时：token 源仅 env 兜底、轮换端点 503。 |
| `IDP_PROVISION_TOKEN` | env 兜底 token（初始装配 / 应急）；密封行存在时不再生效。 |
| `ORIGIN_ENV_IDP_PROVISION_TOKEN` | GitHub `production` Environment secret；Deploy production 时 CI 写入 `server.env`。 |
| `ORIGIN_ENV_PLATFORM_SECRET_KEY` | 同上机制写入 `PLATFORM_SECRET_KEY`；首次启用轮换前必须配置一次。 |
| `IDP_ADMIN_BASE_URL` | 可选；默认 `OIDC_ISSUER` 的 origin |
| `IDP_ADMIN_TENANT` | 可选；默认从 `OIDC_ISSUER` 解析 slug（生产 `ck`） |

## 允许的 IdP 调用

Bearer = provision token，scopes 仅：

- `tenant.read` → `GET /admin/tenants`
- `user.read` → `GET /admin/tenants/:id/users`
- `user.provision` → `POST /admin/tenants/:id/users` body `{email, display_name}`

不调用 `/admin/login`、tenant CRUD、key rotate、clients、service-principals 签发/吊销。

## 签发（两条自动通道 + 一条手工通道）

1. **管线 bootstrap（首次/全新环境）**：ma_hono `deploy.yml` 在迁移后跑
   `scripts/bootstrap-sck-provisioner.sh`——无 active principal 时以部署通道为
   信任根 mint `sck-provisioner`（D1 只存 sha256），token 经 stdin 注入
   `ORIGIN_ENV_IDP_PROVISION_TOKEN`；已有 active 则跳过。该 secret 是本产品的
   env 兜底源，密封行建立后自动失效。
2. **ops broker 一键轮换（日常轮换，含首次密封建仓）**：见下节。
3. **手工 mint（排障/合规绕行）**：`sck call ops_idp_principal_mint` /
   `ops_idp_principal_revoke` / `ops_idp_principal_list`，scopes 固定
   `tenant.read`、`user.read`、`user.provision`；mint 只回显一次 token。
   历史替代路径（人类 admin console 会话）仅保留为应急手段，密码不进 secrets。

## 轮换（免部署，常规路径）

首选一条命令：`sck call ops_idp_provision_rotate`（ops broker 组合工具）。
它自动完成「吊销旧 principal → mint 新 principal（token 密封在 broker）→
经运营会话调本产品 rotate 端点注入密封仓 → status + 新旧 token IdP 双探针」，
明文不出 broker 进程；多个 active principal 时必须显式传 `revokePrincipalId`
（用 `ops_idp_principal_list` 选定）。注入失败会补偿吊销新 principal。

分解动作（排障或 broker 不可用时手工执行）前提：`PLATFORM_SECRET_KEY`
已在生产配置且 030/031 迁移已应用（`platform_secret` / `platform_secret_event` 表存在）。

1. 经 ops broker mint 新 principal，取一次性 token（终端不回显）。
2. 以持 `subscription.manage` 的运营身份调用：

   ```
   POST /api/ops/idp-provision-token/rotate
   {"token": "<新 token>"}
   ```

   服务端先对 IdP 做只读探测（`GET /admin/tenants` + 租户解析）确认 token 为活，
   再 AES-256-GCM 密封 UPSERT 进 `_system.platform_secret:idp_provision_token`，
   并写 `platform_secret_event`（action=rotate、actor_subject、时间；不含明文/密文）。
   响应只回 `{rotated, source:"store", updatedAt, updatedBy}`。
3. **下一次邀请调用即使用新 token**（每次调用现读密封仓，无缓存）。
4. 确认：

   ```
   GET /api/ops/idp-provision-token/status
   ```

   应返回 `source:"store"`、`idp.reachable:true`；`store.entry` 给出
   `updatedAt` / `updatedBy`。
5. 经 ops broker revoke 旧 principal。`env` 兜底值从此不再可达属于预期；
   若需同步清理 `ORIGIN_ENV_IDP_PROVISION_TOKEN`，走 bootstrap/应急小节，不属于常规轮换。

失败处理：

- `idp-provision-token-invalid`（400）：IdP 探测拒绝候选 token；核对 mint 输出的
  principal 未先被吊销、scopes 正确。
- `idp-provision-store-not-configured`（503）：`PLATFORM_SECRET_KEY` 未配置；
  先按 bootstrap 小节补一次 secret + 一次部署。
- `idp-provision-probe-failed`（502）：IdP 不可达；稍后重试，未写任何状态。
- `secret-write-verify-failed`（500）：写后回读校验失败；查 SurrealDB 写入健康后重试。

## 状态与审计

`GET /api/ops/idp-provision-token/status`（`quota.read`）返回：现行来源
（`store`/`env`/null）、env 兜底是否仍在、密封行元数据（`updatedAt`/`updatedBy`，
不含明文）、解封错误（`unsealError`）与 IdP 只读探测结果（`reachable`/HTTP 状态）。
轮换归因查 `_system.platform_secret_event`：`actor_subject`、`action`、`occurred_at`。

## Bootstrap / 应急

**常规 bootstrap 已由 ma_hono 部署管线自动完成**（见「签发」第 1 条），无需
人工签发。下列三种情况才使用本小节的手工路径，且必须事后记录原因：
管线 bootstrap 未生效（如 `SCK_REPO_TOKEN` 未配置）、
`PLATFORM_SECRET_KEY` 尚未配置、或密封仓不可用需要临时回退 env。

1. 经 ops broker mint principal，取一次性 token。
2. 本机执行（stdin 读入，不回显到证据）：

   ```bash
   gh secret set ORIGIN_ENV_IDP_PROVISION_TOKEN --env production
   ```

3. **重跑**同一提交或下一次 `Deploy production`，让 CI 重写 `server.env`。
4. 确认 `https://l.maplayer.top/health` 为 `status=ok` 且 `surrealdb=up`；
   `GET /api/ops/idp-provision-token/status` 应返回 `source:"env"`。

`PLATFORM_SECRET_KEY` 的首次配置同理：`gh secret set ORIGIN_ENV_PLATFORM_SECRET_KEY
--env production`（值由 `openssl rand -hex 32` 生成）+ 一次部署。此后 token 轮换
不再需要部署。注意：更换 `PLATFORM_SECRET_KEY` 会使既有密封行全部不可解
（fail closed），属破坏性操作，须先轮换回 env 兜底再更换。

## 核对 secret 名单（不读值）

```bash
gh secret list --env production
```

- 应出现：`ORIGIN_ENV_IDP_PROVISION_TOKEN`、`ORIGIN_ENV_PLATFORM_SECRET_KEY`
- **不得**出现：`ORIGIN_ENV_IDP_ADMIN_EMAIL`、`ORIGIN_ENV_IDP_ADMIN_PASSWORD`
