# Surreal CK Ops

独立的运营控制台，不与客户 `web/` 共用页面路由。使用 OIDC Authorization Code + PKCE，向 Hono 的配额与平台内容维护 API 发送独立运营 audience 的 bearer token。

当前页面包含六个模块：

- 配额运营：工作区搜索、计划/配额状态和操作时间线（`/api/ops/quota/*`）。
- 内容维护：来源登记与许可修订、成品批次分页/详情、失败原因和审计查询（`/api/content/*`）。来源许可修订由服务端版本化，批次会保存提交时的许可快照。
- 团队启用摘要：只读取工作区管理员主动共享、可撤回的最小摘要。
- 机会与跟进：从新鲜摘要派生内部机会，建立有期限租约的跟进事项。
- 建议审阅：页面与 MCP 共用 `/api/ops/proposals` 领域服务。建议提交、人工审批、受限内部执行分开；审批绑定动作摘要及事项版本，执行时重新验证来源和 capability。人工接管会使旧租约及旧版本建议失效。不会向客户发送消息或修改商业权益。
- Agent 授权：真人运营人员按 agent、工作区和动作白名单配置自治范围，并可暂停、恢复、撤权及查看审计历史（`/api/ops/autonomy/*`）。agent 读取摘要/机会/事项/建议和发起内部动作时，服务端按当前 capability、OIDC scope、工作区与动作策略共同校验；未配置或暂停后的新请求会明确拒绝。已进入执行流程的动作可能自然完成，不会被伪称回滚；恢复保留原幂等历史。
- Agent 运行：授权页显示外部运行宿主上报的持久检查点、最后上报时间、错误和待人工处理状态。此页面不启动或调度 agent；“运行中”只是最近一次报告，不保证进程当前在线。

建议审阅与接管只允许 `_system.platform_operator.kind = "human"` 的运营主体；agent 应登记为 `kind = "agent"`。`activation.proposal.*` 与 `activation.followup.*` capability 仍需显式授权，OIDC scope 会进一步收窄能力。建议审计仅保存结构化输入定位和幂等键摘要，不存 token、案件正文或模型隐藏推理。

外部单次运行示例位于 `server/scripts/ops-agent-runner.ts`。由用户自己的运行宿主按需要启动，例如每小时一次；仓库不会自动创建定时作业。运行进程通过真实 MCP `tools/call` 发现机会、创建及认领内部事项、提交待审建议，并通过 `get_agent_run_checkpoint` / `save_agent_run_checkpoint` 恢复。副作用前先持久化待核实调用及稳定幂等键；重启后用同一键读取既有结果，不重复产生成功动作。示例中的固定判断只建议内部等待与人工审阅，不会宣称客户问题已解决或发送消息。陈旧摘要不会被当作实时监测。

运行宿主需提供 `OPS_MCP_URL`（如 `https://api.example.com/api/ops/mcp`）、`OPS_AGENT_ACCESS_TOKEN`、`OPS_AGENT_WORKSPACE`，可选 `OPS_AGENT_RUN_KEY`。预算配置为 `OPS_AGENT_MAX_ACTIONS`（默认 20）、`OPS_AGENT_MAX_RETRIES`（默认 3）、`OPS_AGENT_MAX_DURATION_MS`（默认 60000）、`OPS_AGENT_INTERVAL_MS`（默认 3600000）。运行前由宿主刷新短期 OAuth token，确保 agent 身份、scope 与当前策略均有效；不要把 token 写入配置、日志或检查点。示例执行命令：`pnpm --filter @surreal-ck/server exec bun scripts/ops-agent-runner.ts`。退出后不再主动运行；后续是否调度由宿主明确负责。

```bash
pnpm --filter @surreal-ck/ops install
pnpm --filter @surreal-ck/ops dev
pnpm --filter @surreal-ck/ops build
```

生产环境配置 `VITE_OPS_OIDC_ISSUER`、`VITE_OPS_OIDC_CLIENT_ID`、`VITE_OPS_OIDC_AUDIENCE` 和 `VITE_OPS_API_BASE_URL`。后端可选配置同一个 `OIDC_OPS_CLIENT_ID` 做硬绑定；未配置时仍由 IdP 校验 public client、redirect URI 与 PKCE。运营 API 仍在 `surreal_ck/server`，页面可部署到独立静态站点或同域反向代理路径。
