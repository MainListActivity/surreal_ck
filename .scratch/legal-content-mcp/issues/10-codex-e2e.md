Status: done
Label: verified
Assignee: codex
ID: SCK-LCM-10
Repository: surreal_ck

# 完成 Codex 自动接入与内容生命周期验收

Parent: [实施规格](../PRD.md)

## Dependencies

- [04-ops-app](04-ops-app.md)
- [07-mcp-oauth](07-mcp-oauth.md)
- [08-source-audit-ui](08-source-audit-ui.md)
- [09-local-runner](09-local-runner.md)
- IdP：/Users/y/IdeaProjects/ma_hono/.scratch/ops-mcp-oauth/PRD.md（IDP-OM-01/02/03）。

## Scope

- 从未预注册 Codex 客户端开始，添加 MCP URL，发现、DCR、浏览器授权、五工具调用、刷新/重连和撤销。
- 至少一份完整法规与完整文书完成提交/定位/法条拆分/部分发布/修订/撤回/恢复及客户读取测试。
- 提供发布清单：域名回调、issuer/resource、版本固定、迁移顺序、来源资格、备份和停服回退步骤。
- 保持 content 发布默认关闭直到验收，不删除客户数据、不在回退时抹去审计。

## Acceptance

- [x] 测试记录精确列明客户端版本、IdP/fork版本、fixtures 与未支持项，不以手工 token 替代。
- [x] 运营 MCP 使用独立 audience；普通工作区 token 与无运营能力 subject 均由 guard 拒绝，旧 token 撤权和错误受众均有自动化覆盖。
- [x] 发布/修订/撤回/恢复均以批次和 idempotency key 留存；本轮 schema 迁移只扩展字段定义，不删除内容、版本或审计记录；代码回退不会回收数据，后续前滚会识别已应用的 schema version 4。

## 当前进度

- [x] `ma_hono` 生产 Worker 已部署，D1 迁移 `0011_mcp_resource_scope.sql` 与
  `0012_consent_challenges.sql` 已应用；`ck` issuer discovery 已返回 MCP
  resource、scope、DCR 与 revocation 元数据。
- [x] 通过生产 DCR 验证 `native` loopback client、managed resource 与
  `openid content.read` scope 请求；错误缺少 `application_type` 会被拒绝。
- [x] `surreal_ck` Hono 已部署到 `l.maplayer.top`，Cloudflare edge → Caddy → Bun
  链路保持公网 host/proto；Protected Resource Metadata、未认证 401 discovery
  challenge 均返回 `https://l.maplayer.top/api/ops/mcp` 对应的公网 resource。
- [x] 已在已部署的 `surreal_ck` MCP URL 上完成未预注册客户端 DCR、已登录 IdP 会话的
  直接同意、授权码 + PKCE 换 token、五工具调用、刷新/重连及 refresh/access 撤销。
- [x] 生产 synthetic 验收已完成文书发布 → 修订 → 撤回 → 恢复 → 已发布投影读取，以及
  法规发布 → 条文拆分 → 已发布投影读取。所有验收来源均为 `fixture.synthetic.cn`，
  明确不可售，不是公开法规或裁判文书。

## 本轮外部验证记录

- IdP Worker 版本：`0e95ee90-afcb-4019-bcf5-4059c75e3588`（已包含 MCP registration client lifecycle）。
- 发现端点：`https://o.maplayer.top/t/ck/.well-known/openid-configuration`。
- DCR 端点：`https://o.maplayer.top/t/ck/connect/mcp/register`。
- MCP 端点：`https://l.maplayer.top/api/ops/mcp`。
- Protected Resource Metadata：`https://l.maplayer.top/api/ops/.well-known/oauth-protected-resource`。
- DCR 返回 `201`；测试客户端只用于联调，未签发用户 token。生命周期接口已用临时
  client 验证 `GET=200`、`DELETE=204`；历史联调 client 已从生产 D1 定向清理，
  并补写 `oidc.client.deleted` 审计事件（不删除原注册审计）。
- 生产链路验证：`GET /health=200`、`GET` Protected Resource Metadata `=200`、
  未带 bearer 的 `POST /api/ops/mcp=401`，且 `WWW-Authenticate` 指向上述公网
  metadata URL；SurrealDB 服务保持运行，本轮只重启 Hono 服务。
- 本轮 Hono release：`779ee75`；远端 TypeScript 预检通过，原子切换后
  `surreal-ck-hono.service=active`、`surrealdb.service=active`，旧 release 保留可回退。
- 已增加安全 bootstrap 配置：部署者可在 Hono 环境中显式指定 OIDC subject 与
  内容能力，服务启动时只补缺失授权；当前生产环境尚未写入该配置，避免未经真人
  确认授予平台运营权限。
- 已提交可复用的 ego-browser 页面脚本
  `.scratch/legal-content-mcp/scripts/ego-mcp-e2e.mjs`：复用 TaskSpace 1/p1，
  不携带密码；密码为空时交还用户，完成后将 loopback 回调安全写入临时文件。
- 已提交可复用的 OAuth/MCP 验收脚本
  `.scratch/legal-content-mcp/scripts/mcp-oauth-e2e.mjs`：校验 state、交换授权码、
  调用 initialize/tools/list 与五个工具，并在存在 refresh token 时验证刷新、重连和
  撤销；凭证与完整报告只写入本机 0600 临时文件，不打印 secret/code/token。
- 2026-09-11 生产实际验收：IdP Worker `c3029479-89f8-4b2c-b54b-4f097a24596d`，
  Hono release `afbc731`，平台内容 schema `v4`，MCP server `1.0.0` / protocol
  `2025-06-18`。Ego 复用 TaskSpace 1/p1，从已登录的 `auth.maplayer.top` 会话直接进入
  同意并回调，未出现密码表单。
- `--fixture --publish --full-lifecycle` 的报告为 `ok=true`、0 failures：初始发布、文书
  修订及读取、撤回及不可读取、恢复及重新读取、法规和条文读取、refresh/reconnect、
  refresh/access revoke 均通过。临时 DCR client 之后以注册 access token 删除（204），
  本机 OAuth 临时文件也已清理；仓库仅保留可复用脚本。
- 本仓测试：`RUN_LOCAL_PLATFORM_CONTENT_TESTS=1 LOCAL_SURREAL_URL=ws://127.0.0.1:9132/rpc pnpm --filter @surreal-ck/server test`
  结果为 356 pass、11 explicit local integration skips、0 fail；平台内容 migration 001–004
  均经 `surreal validate` 校验。`operator-auth` 测试覆盖独立 audience、无能力运营主体、
  IdP 报告的撤销 token；运营 MCP 不绑定客户 workspace，因此不存在可越过的 workspace
  租户选择路径。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
