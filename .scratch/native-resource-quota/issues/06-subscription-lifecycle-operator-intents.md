Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-06 — 实现 subscription lifecycle、service mode 与运营意图

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- 实现 normalized subscription/item 状态、effective/paid-through/grace/cancel 时间、provider inbox 幂等和当前状态 reconciliation。
- service mode 独立解析为 standard/grace/retention；past_due 宽限结束、trial/cancel 到期产生 retention entitlement。
- 实现 manual/contract subscription、版本化 override、plan rollout、payer switch 和 scheduled effective_at。
- 所有 ops mutation 接受 actor capability、customer/internal reason、idempotency key、impact preview，先写审计意图再唤醒 resolver/reconciler。
- operator capabilities 至少拆分 read、subscription、override、reconcile/audit、drift、rebuild。

## Acceptance criteria

- [ ] duplicate/out-of-order provider events 不回退本地 revision。
- [ ] 计划升级 applied 前不开放额度；降级可超额但不删数，进入非恶化模式。
- [ ] cancel/trial end/past_due grace/恢复付款的时间边界测试齐全。
- [ ] 同一人兼任 billing/workspace admin 时能力取并集，任一身份不推导另一身份。
- [ ] HTTP 成功只表示 intent 已持久化，operation 完成以 INFO readback 为准。

## Dependencies

- Blocked by: [`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)
- Blocks: [`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)、[`实现客户配额页面与平台运营面板`](08-quota-settings-operations-ui.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)
