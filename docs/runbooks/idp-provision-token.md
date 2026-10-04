# IdP provision token（可吊销机器凭证）

运营代办开通（`POST /api/ops/invitations`）通过 ma_hono admin API 开通用户时，使用 **可吊销 service principal**，不使用人类 admin 密码。

## 红线

- **禁止**把 ma_hono 人类 admin 密码写入 GitHub secrets、`server.env`、应用配置或 CI。
- 若有人要求配置 `ORIGIN_ENV_IDP_ADMIN_EMAIL` / `ORIGIN_ENV_IDP_ADMIN_PASSWORD`（或任何等价密码注入），视为红线：拒绝，并向经理 `report_blocker to=gm`。
- Token 明文不得进入仓库、PR、日志、审计 payload、任务证据或聊天。

## 进程配置

| 环境 | 说明 |
| --- | --- |
| `IDP_PROVISION_TOKEN` | 进程读取的 opaque bearer（必填才会装配客户端） |
| `ORIGIN_ENV_IDP_PROVISION_TOKEN` | GitHub `production` Environment secret；Deploy production 时 CI 写入 `server.env` |
| `IDP_ADMIN_BASE_URL` | 可选；默认 `OIDC_ISSUER` 的 origin |
| `IDP_ADMIN_TENANT` | 可选；默认从 `OIDC_ISSUER` 解析 slug（生产 `ck`） |

缺少 `IDP_PROVISION_TOKEN` 时，邀请端点在调用 IdP **之前** fail closed：HTTP **503**，错误码 `invite-idp-not-configured`。

## 允许的 IdP 调用

Bearer = provision token，scopes 仅：

- `tenant.read` → `GET /admin/tenants`
- `user.read` → `GET /admin/tenants/:id/users`
- `user.provision` → `POST /admin/tenants/:id/users` body `{email, display_name}`

不调用 `/admin/login`、tenant CRUD、key rotate、clients、service-principals 签发/吊销。

## 签发（人类 admin 会话，仅操作者本机）

1. 用现有人类 admin 登录生产 IdP（密码不发给员工、不进 secrets）。
2. `POST /admin/service-principals`，scopes：`tenant.read`、`user.read`、`user.provision`。
3. 响应里的 `token` 只出现一次；立即写入 secret 存储。

详见 ma_hono `docs/admin-service-principals.md`。

## 轮换

1. 在 IdP admin 用人类会话 **吊销** 当前 principal（`POST /admin/service-principals/:id/revoke`）。
2. **签发** 新 principal（同上 scopes）。
3. 本机执行（stdin 读入，不回显到证据）：

   ```bash
   gh secret set ORIGIN_ENV_IDP_PROVISION_TOKEN --env production
   ```

4. **重跑** 同一提交或下一次 `Deploy production`，让 CI 重写 `server.env`。
5. 确认 `https://l.maplayer.top/health` 为 `status=ok` 且 `surrealdb=up`。

全程不读、不写人类 admin 密码。

## 核对 secret 名单（不读值）

```bash
gh secret list --env production
```

- 应出现：`ORIGIN_ENV_IDP_PROVISION_TOKEN`
- **不得**出现：`ORIGIN_ENV_IDP_ADMIN_EMAIL`、`ORIGIN_ENV_IDP_ADMIN_PASSWORD`
