Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-08 — 实现客户配额页面与平台运营面板

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- workspace settings 增加当前 applied plan、待应用变更、table/field/record 用量、capacity/compliance/sync/service mode 与刷新时间。
- billing admin 视图显示账户分配、subscription/grace/cancel 与聚合利用率；普通成员只展示当前失败的裁剪说明。
- `/api/ops` 独立运营入口支持 workspace/account 搜索、四指针、usage/drift/ledger、operation/attempt/audit 时间线。
- 支持 manual/contract、override、排期降额、retry/audit/reapply/adopt/rebuild 等审计意图和 operation tracking。
- 所有高影响动作显示 current/target diff、fresh usage、预计 overage、effective_at、原因与二次确认。

## Acceptance criteria

- [ ] 同一用户多能力页面按 capabilities 组合，不靠角色名硬编码。
- [ ] stale/unknown 明示，不把缓存用于乐观允许写入。
- [ ] 运营浏览器从不获得 root token、完整 native DDL、业务记录或内部 provider payload。
- [ ] 手工计划控制不能直接修改 current/applied/usage。
- [ ] quota error 后 draft 保留，用户能理解删除/升级/联系管理员等恢复路径。

## Dependencies

- Blocked by: [`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)
- Blocks: [`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)
