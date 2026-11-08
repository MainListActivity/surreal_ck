# 远程 VPS 会话（remote grant）

远程 VPS 上的 AI 用一次性兑换码拿到测试账号的 token，直连生产 SurrealDB 读写测试 workspace，
并以运营身份写/发布平台内容。测试账号与 workspace 约一个月后自动删除，无提醒。

## 链接格式

运营系统发放：`https://o.maplayer.top/t/ck/remote#code=<一次性码>&client_id=<remote client>&api=https%3A%2F%2Fl.maplayer.top&aud=<产品 audience>&ops_aud=<运营 audience>&db_url=<可选>`。
fragment 不进请求日志；`code` 只能换一次。

## 用法

```bash
# 1) 兑换（一次性）：写会话文件到 $SCK_REMOTE_SESSION 或 $XDG_CONFIG_HOME/sck-remote/session.json
bun scripts/remote-session.ts redeem '<链接>'

# 2) 拿 access token（产品 audience；--ops 换运营 audience）——stdout 只输出 token
TOKEN=$(bun scripts/remote-session.ts token)
OPS_TOKEN=$(bun scripts/remote-session.ts token --ops)

# 3) 拿 workspace DB 连接（JSON：url/namespace/database/token/expiresAt）
bun scripts/remote-session.ts db <workspace-slug>

# 4) 查看会话元信息（不打印 token）
bun scripts/remote-session.ts status
```

## 以 DB token 直连 SurrealDB

`db` 子命令内部先 refresh 换产品 audience access token，再调
`POST /api/session/switch-workspace {workspaceSlug}` 拿到 scope exchange 的 DB token。
用 SDK signin 该 JWT 即可读写该 workspace（`ac`/`db`/`RL` claim 照常生效）。

## 写/发布平台内容

运营 token（`token --ops`）直接调 `/api/content/*`：

```bash
curl -X POST https://l.maplayer.top/api/content/batches \
  -H "authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"sourceId":"...","entries":[...]}'
curl -X POST https://l.maplayer.top/api/content/publications \
  -H "authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"entries":[...]}'
```

前提是测试主体登记时授予了 `content.submit`/`content.publish` 能力（PUT /api/ops/test-subjects 的 `contentCapabilities`）。

## 有效期与续期

- access token ≤1h；`token`/`db` 每次内部用 refresh 换新票并原子写回会话文件。
- refresh token 单次轮换：旧票重放会让 IdP 撤销整个 grant（脚本用锁文件防并发，**不要手动并发调用**）。
- grant 绝对期由签发时设定（≤31 天）；到期后 `token` 返回 `invalid_grant`。

## 撤销与到期表现

- grant 被撤销或测试主体到期：`token`/`db` 报 `invalid_grant`/上游 4xx；运营 API 返回 403 `test-subject-expired` 或 `test-subject-not-allowed`。
- 到期后 reaper（每 6 小时，`TEST_SUBJECT_REAPER_INTERVAL_SEC`）删除测试 workspace 整个 database、`_system` 索引/配额行与 test_subject 行；平台内容不删。

## 红线

- 会话文件只放本机（0700 目录/0600 文件），不进 git、日志或任务证据。
- 不要在 stdout/日志中打印 token 或兑换码；`status` 只输出非敏感字段。
- 不要把 remote client token 用于非测试主体；server 端也会拒绝（OIDC_REMOTE_CLIENT_ID 双保险）。
