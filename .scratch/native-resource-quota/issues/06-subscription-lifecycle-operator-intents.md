Status: done
Label: done
Assignee: codex

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

- [x] duplicate/out-of-order provider events 不回退本地 revision。
- [x] 计划升级 applied 前不开放额度；降级可超额但不删数，进入非恶化模式。
- [x] cancel/trial end/past_due grace/恢复付款的时间边界测试齐全。
- [x] 同一人兼任 billing/workspace admin 时能力取并集，任一身份不推导另一身份。
- [x] HTTP 成功只表示 intent 已持久化，operation 完成以 INFO readback 为准。

## Dependencies

- Blocked by: [`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)
- Blocks: [`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)、[`实现客户配额页面与平台运营面板`](08-quota-settings-operations-ui.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)

## Comments

**2026-07-28（Codex，完成）**

- `_system` 011 增量补齐 provider/operator durable processing state：immutable inbox/intent 与 mutable lease/fencing/retry/result state 分离；不可重试失败进入明确终态，scheduled intent 仅在 `effective_at` 到期后可领取。
- provider snapshot 以 `(provider, provider_subscription_id, provider_source_revision)` 单调应用；重复 event 幂等，乱序/同 revision event 标记 `stale_ignored`，不会回退 subscription revision 或状态；应用后崩溃可按 state 上的 applied pointer 重放 resolver。
- 新增 `QuotaLifecycleCoordinator`、`SurrealQuotaLifecycleStore` 和 `SurrealEntitlementRefreshService`：manual/contract、plan rollout、payer switch、subscription end、版本化 override、reconcile/drift intent 均先校验独立 operator capability，持久化 customer/internal reason、impact preview、idempotency digest，再异步执行。
- operator mutation 在同一事务中复核 lease owner/fencing token，并持久化 `affected_workspaces`；进程在 mutation 与 resolver 之间崩溃后可接管重放，不重复递增 subscription revision，也不会丢失待刷新 workspace。workspace/billing 角色不会推导 platform operator 权限，同一 subject 的多个独立身份只按实际 capability 生效。
- entitlement resolver 补齐 canceled/paused/expired 的 paid-through 半开边界与付款恢复；`SurrealLifecycleBoundarySweepHandler` 主动处理 trial、grace、cancel、paid-through、item 和 override 到期，即使没有后续 provider webhook 也会生成 retention/standard desired entitlement。
- desired entitlement/projection 与 materialization operation 原子生成；`workspace_quota_runtime.service_mode` 保持当前 applied mode，只有 reconciler 完成 native apply + INFO readback 后才与 applied pointers 一起推进。因此升级未完成前不提前开放额度，降级沿用引擎的 over-limit 非恶化语义，不删除数据。
- 生产启动新增 durable quota runtime：provider inbox、operator intent、materialization worker 和 lifecycle boundary sweep 四条循环；启动失败不阻塞主服务，shutdown 在关闭 root 连接前停止所有 quota loop。
- 验证：`pnpm test`（shared 92 / server 278 / web 472 pass）、`pnpm typecheck`、`surreal validate` 全部通过；真实 SurrealDB `_system` 11 段迁移/权限/幂等 45 assertions、materialization lease/store 15 assertions、完整 subscription lifecycle 38 assertions 均通过。
