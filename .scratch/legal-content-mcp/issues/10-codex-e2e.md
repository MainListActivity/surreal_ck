Status: open
Label: ready-for-agent
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

- [ ] 测试记录精确列明客户端版本、IdP/fork版本、fixtures 与未支持项，不以手工 token 替代。
- [ ] 跨租户/普通用户/旧token撤权/错误受众测试通过；任何外部失败均有准确结果。
- [ ] 回退演练保留版本与批次，重新开启可幂等恢复；生产发布须按部署授权执行。

## 当前进度

- [x] `ma_hono` 生产 Worker 已部署，D1 迁移 `0011_mcp_resource_scope.sql` 与
  `0012_consent_challenges.sql` 已应用；`ck` issuer discovery 已返回 MCP
  resource、scope、DCR 与 revocation 元数据。
- [x] 通过生产 DCR 验证 `native` loopback client、managed resource 与
  `openid content.read` scope 请求；错误缺少 `application_type` 会被拒绝。
- [x] `surreal_ck` Hono 已部署到 `l.maplayer.top`，Cloudflare edge → Caddy → Bun
  链路保持公网 host/proto；Protected Resource Metadata、未认证 401 discovery
  challenge 均返回 `https://l.maplayer.top/api/ops/mcp` 对应的公网 resource。
- [ ] 仍需在已部署的 `surreal_ck` MCP URL 上完成 Codex 实际接入、真人授权、五工具
  调用、刷新和撤销。当前环境仍没有可用于临时 DCR client 的 tenant 登录方式，
  `_system` 中也没有启用的 `platform_operator` 能力；因此不能用手工 token 或
  未授权的生产权限变更代替真人验收。

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

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
