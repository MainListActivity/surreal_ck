# Surreal CK Ops

独立的运营控制台，不与客户 `web/` 共用页面路由。使用 OIDC Authorization Code + PKCE，向 Hono 的配额与平台内容维护 API 发送独立运营 audience 的 bearer token。

当前页面包含六个模块：

- 配额运营：工作区搜索、计划/配额状态和操作时间线（`/api/ops/quota/*`）。
- 内容维护：来源登记与许可修订、成品批次分页/详情、失败原因和审计查询（`/api/content/*`）。来源许可修订由服务端版本化，批次会保存提交时的许可快照。
- 团队启用摘要：只读取工作区管理员主动共享、可撤回的最小摘要。
- 机会与跟进：从新鲜摘要派生内部机会，建立有期限租约的跟进事项。
- 建议审阅：页面与 MCP 共用 `/api/ops/proposals` 领域服务。建议提交、人工审批、受限内部执行分开；审批绑定动作摘要及事项版本，执行时重新验证来源和 capability。人工接管会使旧租约及旧版本建议失效。不会向客户发送消息或修改商业权益。
- Agent 授权：真人运营人员按 agent、工作区和动作白名单配置自治范围，并可暂停、恢复、撤权及查看审计历史（`/api/ops/autonomy/*`）。agent 读取摘要/机会/事项/建议和发起内部动作时，服务端按当前 capability、OIDC scope、工作区与动作策略共同校验；未配置或暂停后的新请求会明确拒绝。已进入执行流程的动作可能自然完成，不会被伪称回滚；恢复保留原幂等历史。

建议审阅与接管只允许 `_system.platform_operator.kind = "human"` 的运营主体；agent 应登记为 `kind = "agent"`。`activation.proposal.*` 与 `activation.followup.*` capability 仍需显式授权，OIDC scope 会进一步收窄能力。建议审计仅保存结构化输入定位和幂等键摘要，不存 token、案件正文或模型隐藏推理。

```bash
pnpm --filter @surreal-ck/ops install
pnpm --filter @surreal-ck/ops dev
pnpm --filter @surreal-ck/ops build
```

生产环境配置 `VITE_OPS_OIDC_ISSUER`、`VITE_OPS_OIDC_CLIENT_ID`、`VITE_OPS_OIDC_AUDIENCE` 和 `VITE_OPS_API_BASE_URL`。后端可选配置同一个 `OIDC_OPS_CLIENT_ID` 做硬绑定；未配置时仍由 IdP 校验 public client、redirect URI 与 PKCE。运营 API 仍在 `surreal_ck/server`，页面可部署到独立静态站点或同域反向代理路径。
