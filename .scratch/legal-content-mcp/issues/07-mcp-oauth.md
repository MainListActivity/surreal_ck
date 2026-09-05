Status: blocked
Label: needs-triage
Assignee: unassigned
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

- [ ] 未认证请求正确引导发现，普通客户和错误受众拒绝。
- [ ] 五工具协议测试通过，包括分页、幂等、部分发布和结构化错误。
- [ ] 与 IDP-OM-01/02/03 联测 DCR、PKCE、scope、refresh；未预注册客户端路径通过。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
