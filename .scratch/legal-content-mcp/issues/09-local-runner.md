Status: blocked
Label: needs-triage
Assignee: unassigned
ID: SCK-LCM-09
Repository: surreal_ck

# 提供本地采集与持续更新运行方案

Parent: [实施规格](../PRD.md)

## Dependencies

- [07-mcp-oauth](07-mcp-oauth.md)
- [08-source-audit-ui](08-source-audit-ui.md)

## Scope

- 提供本地客户端操作指南和可运行示例，从契约发现到提交/校验/发布；不内置真实凭证。
- 采集网站逻辑留在本地；统一成品格式，来源新增不要求服务端适配代码。
- 持久化检查点、重叠发现、重试、请求幂等键、时间日志和离线提示；定时默认停止在待审核，不因 OAuth 同意自动发布未来批次。
- 刷新令牌采用客户端安全存储；授权撤销或刷新失败停止远端操作并请求重新登录。

## Acceptance

- [ ] 示例针对允许访问来源完成本地成品生成，明确无法获取与来源许可限制。
- [ ] 重复运行不重复入库，离线恢复有检查点，撤销授权后停止提交。
- [ ] 不得用对话常驻或静默自动化冒充产品调度；启用实际日程需运营明确配置。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。

