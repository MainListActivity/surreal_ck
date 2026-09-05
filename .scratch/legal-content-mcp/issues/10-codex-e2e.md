Status: blocked
Label: needs-triage
Assignee: unassigned
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

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
