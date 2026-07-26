Status: done
Label: done
Assignee: codex

# SCK-NQ-02 — 建立 `_system` 订阅、权益、调和与运营权威 schema

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- 追加 `shared/sql/system/*.surql`，建模 billing account/member、plan/revision、subscription/item、override revision、resource entitlement、quota projection。
- 建模 entitlement/materialization operation、append-only attempt、workspace 四指针、sync/audit/compliance cache、provider inbox、operator capability、alert state/outbox。
- 不可变 revision/snapshot 禁止 update/delete；当前运行指针与 lease 明确可变。
- 用唯一索引约束 plan key/revision、provider event、workspace 有效 assignment、operation 幂等身份和 request id。
- 提供共享领域类型，所有 datetime/record id 与 SurrealDB schema 类型一致。

## Acceptance criteria

- [x] migrations 幂等、连续、可在空 `_system` 和已有 workspace 索引上运行。
- [x] 同 workspace 同时最多一个有效基础 subscription item 和一个 active override。
- [x] immutable entities 无更新路径；operation/attempt/audit 可关联完整 causation chain。
- [x] platform operator 与 workspace 创建开关、workspace admin 完全分离。
- [x] schema tests、唯一冲突、权限拒绝与重启迁移测试齐全。

## Dependencies

- Blocked by: none
- Blocks: [`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)

## Comments

**2026-07-26（Codex，完成）**

- 新增 `_system` 004–006 连续增量，建立 billing/plan/subscription/override、entitlement/projection/materialization、provider/operator/audit/alert/outbox 权威模型；所有控制面表均为 `PERMISSIONS NONE`。
- plan revision、override revision、entitlement、projection、operation、attempt、provider inbox、operator intent、audit 和 notification outbox 通过事件保持 append-only；materialization operation 仅在非终态可变。
- active subscription item 使用计算出的 `active_workspace` 唯一索引；override 使用每 workspace 单一 assignment 行；plan revision、provider event、idempotency key 与 request id 均有唯一约束。
- workspace 增加 desired/applied entitlement 与 projection 四指针；runtime 单独保存 sync、service mode、compliance、capacity、账本可信度与 lease，不把瞬时状态写入不可变快照。
- 共享领域类型全部使用 SurrealDB SDK `DateTime` / `StringRecordId`，并覆盖精确表名与正则表名 selector。
- 默认 schema 测试和 migration runner 重启测试通过；本地 SurrealDB 3.2.3 内存实例验证旧 workspace 升级、唯一冲突、不可变回滚、RECORD access 权限拒绝、causation chain 与六个增量重跑。
- 验证：`pnpm typecheck`、`pnpm test`、`surreal validate 'shared/sql/system/*.surql'`、`pnpm --filter @surreal-ck/shared test:system-schema:local` 全部通过。`@surrealdb/surql-fmt` 当前会错误重写 `rules.*` / `patches.*` 字段路径，因此这些迁移以官方 CLI validate 和执行期集成测试为语法权威，并有静态回归测试防止通配路径再次损坏。
