Status: done
Label: done
Assignee: codex

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

- [x] 多 Bun 实例不并发物化同一 workspace，lease 过期和 fencing token 测试通过。
- [x] commit unknown 先 INFO 决定结果，不盲目重复 DDL。
- [x] crash/restart 后 operation、attempt、backoff 与 cursor 可恢复。
- [x] desired 更新可 supersede 未开始 operation；已执行旧 operation 完成 readback 后再追最新版。
- [x] policy missing、ledger corrupt、external drift 与 incompatible 的处置符合决策且不 REMOVE quota 放宽。

## Dependencies

- Blocked by: [`建立跨仓 quota contract、SDK 固定版本与启动能力门`](01-contract-sdk-capability-gate.md)、[`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`SurrealDB：交付 INFO、REBUILD、结构化错误与观测`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/05-info-rebuild-errors-observability.md)、[`SurrealDB：交付 capability、readiness、格式迁移与匹配 CLI`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/06-capability-readiness-migration-cli.md)
- Blocks: [`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)

## Comments

**2026-07-26（Codex，完成）**

- `NativeQuotaClient` 已实现 root-only `INFO FOR QUOTA`、首次 `DEFINE QUOTA`、带 `EXPECT GENERATION` 的全量 overwrite、readback 与 `REBUILD QUOTA IF NEEDED`；数据库标识、regex 和无符号额度均在发送前校验，SDK 的结构化错误保持原样，不解析错误文案，也没有 REMOVE/放宽接口。
- `QuotaReconciler` 采用 INFO-first 决策：目标已存在时零 DDL；missing policy 自动恢复；commit unknown 必须 readback 后判断；corrupt/uninitialized ledger 先 rebuild；external drift 默认终止，只有显式 `drift_reapply` 才以最新 generation 覆盖；incompatible 和永久 contract/IAM/mapping 错误 fail closed。
- 新增生产 `SurrealQuotaControlPlaneStore`：物化 operation、真实 attempt、workspace lease 与 fencing token 分离并持久化；过期租约可接管，旧 owner 无法结算；未执行旧 operation 可 supersede，已执行旧 operation 完成 readback；成功后依据最新 desired pointer 原子决定 `in_sync` 或继续 `pending`。
- 新增 MaterializationWorker、ControlPlaneSweep、NativeAuditSweep、ProviderReconciliation。四类循环共用持久化 cursor/lease/fencing/backoff 内核，各自 cursor 独立，可在崩溃或多 Bun 实例接管后继续。
- `_system` 008 增量补充 materialization reconcile mode/completion 及 sweep retry/backoff/error 状态；共享 DTO 与 schema 版本同步到 8。
- 验证：`pnpm test`、`pnpm typecheck`、官方 `surreal validate` 全部通过；真实 SurrealDB `_system` 八段升级/权限/幂等测试 39 assertions，通过；双 `SurrealQuotaControlPlaneStore` 并发抢占、lease takeover、stale fencing、attempt、cursor/backoff 集成测试 15 assertions，通过。
- 当前本机安装的 SurrealDB 3.2.3 二进制早于 quota grammar 合入，因此 native quota DDL 的精确字符串由当前 fork parser/`ToSql` 契约和客户端单元测试锁定；候选引擎二进制上的跨仓签名/E2E 仍按 SCK-NQ-10 执行。
