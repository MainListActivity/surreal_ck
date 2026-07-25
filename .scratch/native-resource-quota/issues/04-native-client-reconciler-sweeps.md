Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-04 — 实现 NativeQuotaClient、reconciler 与四类恢复循环

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- 实现 root-only NativeQuotaClient：INFO-first、generation-guarded full apply、readback、REBUILD、error preservation。
- `QuotaReconciler` 按 workspace fencing lease 串行处理 desired projection；逻辑 operation 与每次真实 attempt 分离。
- 实现 MaterializationWorker、ControlPlaneSweep、NativeAuditSweep、ProviderReconciliation 四类循环及持久化 cursor/lease/backoff。
- 分类 retryable、commit unknown、ledger rebuild、permanent contract/IAM/mapping error 与 external drift。
- drift 默认停止自动覆盖；运营只能 reapply desired 或转为正式 override。

## Acceptance criteria

- [ ] 多 Bun 实例不并发物化同一 workspace，lease 过期和 fencing token 测试通过。
- [ ] commit unknown 先 INFO 决定结果，不盲目重复 DDL。
- [ ] crash/restart 后 operation、attempt、backoff 与 cursor 可恢复。
- [ ] desired 更新可 supersede 未开始 operation；已执行旧 operation 完成 readback 后再追最新版。
- [ ] policy missing、ledger corrupt、external drift 与 incompatible 的处置符合决策且不 REMOVE quota 放宽。

## Dependencies

- Blocked by: [`建立跨仓 quota contract、SDK 固定版本与启动能力门`](01-contract-sdk-capability-gate.md)、[`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`SurrealDB：交付 INFO、REBUILD、结构化错误与观测`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/05-info-rebuild-errors-observability.md)、[`SurrealDB：交付 capability、readiness、格式迁移与匹配 CLI`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/06-capability-readiness-migration-cli.md)
- Blocks: [`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)
