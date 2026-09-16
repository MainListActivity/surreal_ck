Status: done
Label: verified
Assignee: codex
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

- [x] Runner 接受已登记来源的成品 `IngestionBatch` 文件，并提供明确标记为 synthetic、不可视为真实授权的 `--fixture` 联调样例；文档说明无法获取和许可限制。
- [x] 同一幂等键可安全重跑，原子检查点支持离线恢复；MCP 401/refresh 失败会停止远端操作。
- [x] 不创建或伪装定时调度；实际日程必须由运营显式配置本地 scheduler。

## Verification

- `bun build scripts/platform-content-runner.ts --target bun --outdir /tmp/surreal-ck-content-runner-check`
- `docs/runbooks/platform-content-local-runner.md` 覆盖配置、契约发现、分页 inspect、幂等重跑、离线恢复、撤权停止和人工发布确认。
- Runner 默认只提交并 inspect，只有 `--publish` 且 `CONTENT_PUBLISH_CONFIRM=YES` 才会调用发布工具；不把 OAuth 同意当成批次审阅。

真实中国大陆法规/裁判文书采集仍由本地 agent 按来源许可完成，首期不内置爬虫；网络端到端和 Codex 未预注册路径由 SCK-LCM-10 验收。

## Handoff

- 实施前读取仓库 AGENTS.md 和相关技能；SurrealQL、Mastra 等按任务实际涉及加载。
- 完成后记录改动、验证命令与结果及剩余限制；依赖完成后将下游转为 open/ready-for-agent，不提前声明交付。
- 本票只授权自身实现范围，不隐含线上部署、真实来源商用发布或外部账号配置修改。
