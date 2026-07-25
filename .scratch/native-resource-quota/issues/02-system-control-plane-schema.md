Status: open
Label: ready-for-agent
Assignee: unassigned

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

- [ ] migrations 幂等、连续、可在空 `_system` 和已有 workspace 索引上运行。
- [ ] 同 workspace 同时最多一个有效基础 subscription item 和一个 active override。
- [ ] immutable entities 无更新路径；operation/attempt/audit 可关联完整 causation chain。
- [ ] platform operator 与 workspace 创建开关、workspace admin 完全分离。
- [ ] schema tests、唯一冲突、权限拒绝与重启迁移测试齐全。

## Dependencies

- Blocked by: none
- Blocks: [`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)
