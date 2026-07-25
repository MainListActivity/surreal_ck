Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-09 — 实现旧事件配额盘点、回填与分批切换 conductor

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- 生成 dry-run inventory：workspace/db 映射、旧 plan binding/值、旧 counters、真实 table/field/record、events、预计新 limits/overage、异常。
- 导入运营批准且带 checksum 的 assignment manifest；旧 mutable plan/counter 只作 discrepancy 证据，永不直接成为 entitlement/usage。
- 编排 datastore snapshot/format migration 后，对 `_system` 与全部 workspace database 执行 REBUILD/独立扫描校验。
- 维护窗内为全部 active workspace 应用 native policy、INFO 读回并标 `native_policy_active`；任一缺口都阻止 WSS 重新开放，legacy events 暂时保留双重保护。
- per-workspace 使用幂等 operation：fresh INFO、impact preview，在同一 database transaction 中以 generation guard 重新断言同一 policy 并移除 `sheet`/动态表 legacy quota events，INFO/event readback 后标 native_verified。
- cohort、pause/abort/resume、commit unknown readback、cleanup eligibility 与 30 日延迟清理。

## Acceptance criteria

- [ ] 每个 active workspace 恰有一条批准 assignment；unknown/duplicate/mapping mismatch 阻止切换。
- [ ] old counters 从不写入 native ledger；native usage 与独立扫描必须完全一致。
- [ ] WSS 重新开放前每个 active workspace 已有读回一致的 native policy；不存在只靠 legacy event 的开放窗口。
- [ ] 去旧 transaction 失败时 native policy 始终保留，legacy events 状态可读回收敛；提交未知时 INFO-first。
- [ ] 并发旧事务在 policy generation 边界整体按旧或新语义，不部分提交。
- [ ] 任一 false-negative、counter mismatch、ledger corrupt、结构化错误丢失或未知 drift 自动暂停 cohort。
- [ ] 清理前 old events 已停用、全部 workspace verified、稳定 30 日且旧应用版本被 compatibility gate 淘汰。

## Dependencies

- Blocked by: [`SurrealDB：认证持久 backend、并发一致性与性能`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/07-backend-certification-fault-performance.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)
- Blocks: [`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)
