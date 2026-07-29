Status: done
Label: done
Assignee: codex

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

- [x] 每个 active workspace 恰有一条批准 assignment；unknown/duplicate/mapping mismatch 阻止切换。
- [x] old counters 从不写入 native ledger；native usage 与独立扫描必须完全一致。
- [x] WSS 重新开放前每个 active workspace 已有读回一致的 native policy；不存在只靠 legacy event 的开放窗口。
- [x] 去旧 transaction 失败时 native policy 始终保留，legacy events 状态可读回收敛；提交未知时 INFO-first。
- [x] 并发旧事务在 policy generation 边界整体按旧或新语义，不部分提交。
- [x] 任一 false-negative、counter mismatch、ledger corrupt、结构化错误丢失或未知 drift 自动暂停 cohort。
- [x] 清理前 old events 已停用、全部 workspace verified、稳定 30 日且旧应用版本被 compatibility gate 淘汰。

## Dependencies

- Blocked by: [`SurrealDB：认证持久 backend、并发一致性与性能`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/07-backend-certification-fault-performance.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)
- Blocks: [`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)

## Comments

**2026-07-29（Codex，完成）**

- 新增不可变 migration inventory/assignment/signal、durable run/cohort/per-workspace operation、lease/fencing 与状态机；dry-run 同时记录 workspace/db 映射、旧三档 plan/binding/counter/event 证据、独立 table/field/record 扫描、目标策略和 overage。旧 mutable 值只用于 discrepancy，不进入 entitlement 或 native ledger。
- approved manifest 以 canonical SHA-256 覆盖完整映射，导入前一次性验证 approver `subscription.manage`、所有 active workspace 恰好一条 assignment、billing account、plan revision、source/template kind 与 slug/db 映射。通过后复用标准 subscription resolver/compiler/materializer 写入商业权威，重跑幂等。
- maintenance `prepare` 固定执行 snapshot/restore/fork/backend 证据落库、`_system` 与全部 active workspace `REBUILD QUOTA IF NEEDED`、独立物理扫描、native usage 精确比对、策略物化和 fresh INFO readback。所有 workspace 标记 `native_policy_active` 后才通过公网 reopen gate，旧 events 此时仍保留。
- cohort 按 synthetic/internal、1%、10%、50%、remainder 确定性划分并强制 24h/48h 观察窗。每个 workspace 以 generation guard 在同一 transaction 重新断言完整策略并移除 `sheet`/安全 `ent_*` events；提交未知先 INFO/event/scan 读回，明确未提交保留可重试状态且不会进入观察期，半切或 drift 自动暂停。
- blocking signal、pause/resume/abort、全部 native verified、full audit、pre-native compatibility gate 与 30 日稳定窗均持久化。cleanup evidence 必须在全部 workspace verified 后记录，拒绝未来时间；最终由既有 capability-aware v21 migration 删除 legacy events/tables。
- 新增 `pnpm quota:migration` 运维 CLI 与完整 runbook；`help`/manifest `checksum` 可在无数据库和 OIDC 凭证的离线环境运行，在线命令先做 fork capability/root handshake。
- 验证：`pnpm test`、`pnpm run typecheck`、`pnpm --filter @surreal-ck/web run build`、`surreal validate`、真实 SurrealDB `_system` 13 个 migrations / 52 assertions、真实 migration store 27 assertions、离线 CLI help/checksum 与 `git diff --check` 均通过。双仓签名镜像、fault/concurrency 矩阵与部署发布验收留给 SCK-NQ-10。
