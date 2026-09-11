Status: open
Label: ready-for-agent
Assignee: codex
ID: SCK-LCM-07
Repository: surreal_ck

# 交付 OAuth 保护的五工具 MCP

Parent: [实施规格](../PRD.md)

## Dependencies

- [03-operator-auth](03-operator-auth.md)
- [05-batch-validation](05-batch-validation.md)
- [06-publication](06-publication.md)
- IdP：/Users/y/IdeaProjects/ma_hono/.scratch/ops-mcp-oauth/PRD.md（IDP-OM-01/02/03）。

## Scope

- 在 server/src/ops/mcp/ 实现独立 Streamable HTTP 入口，使用受维护且兼容 Bun/Hono 的 MCP SDK；选型与 API 先核实。
- Protected Resource Metadata、401发现、MCP audience/resource/scope 校验与 IdP 联通；不得透传 token 到数据库。
- 五工具调用已有领域服务，身份仅 OAuth 注入；协议错误与条目业务错误区分，工具结果不泄露凭证。
- publish 绑定明确审阅结果；工具注释与客户端提示不能替代服务端授权或操作前提。

## Acceptance

- [x] 未认证请求正确引导发现；运营 audience、动态能力和错误受众由 middleware 拒绝，普通客户不会进入工具处理。
- [x] 五工具协议测试通过，包括工具发现、分页、幂等和结构化业务错误；发布/撤回/恢复继续复用内容服务的部分发布前提。
- [ ] 与 IDP-OM-01/02/03 的真实 DCR、PKCE、scope、refresh 联测仍由 SCK-LCM-10 完成；当前未预注册 Codex 真人授权受生产 client 登录方式配置阻塞。

## Implementation evidence

- `server/src/ops/mcp/routes.ts` 提供 Streamable HTTP `/api/ops/mcp`、Protected Resource Metadata 和
  `WWW-Authenticate` discovery challenge；每个请求以 OAuth 注入的 `platformOperator` 创建短生命周期 MCP server。
- 五个工具只调用 `PlatformContentService`，不接收或透传数据库 root/service token；token scope 仅收窄实时运营能力，发布仍要求服务端 validation/publication 前提。
- `server/src/ops/operator-auth.ts` 独立验证运营 audience，并在每次请求重新读取 active operator/capability，撤销旧 token 的能力立即生效。
- 验证：`pnpm --filter @surreal-ck/server typecheck`；`pnpm --filter @surreal-ck/shared typecheck`；
  `pnpm --filter @surreal-ck/server exec bun test src/ops/mcp/routes.test.ts src/ops/operator-auth.test.ts --preload ./test/setup-env.ts`
  （4 pass）；server 全量测试 349 pass / 12 skip。

## Current limitation

生产 `ck` tenant 尚未配置可用于临时 DCR client 的登录方式，且 `_system` 中没有
启用的 `platform_operator` 能力；因此不以手工 token 或未授权的生产权限变更冒充
真实 Codex 验收。MCP server 已部署为
`https://l.maplayer.top/api/ops/mcp`，剩余真人授权、五工具、刷新/撤销联测转交
SCK-LCM-10。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
