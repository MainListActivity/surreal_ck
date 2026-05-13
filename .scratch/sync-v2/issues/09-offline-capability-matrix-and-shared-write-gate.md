Status: done
Label: done

# SYNCV2-009 — 离线能力矩阵与 shared-write gate

## Parent

`docs/adr/sync.md`

## What to build

把当前单一的 offline/readOnly 语义改造成能力矩阵。离线时只允许继续本地私有 `research_session`，所有 shared write 都必须被明确拒绝，包括 `ent_* / rel_*`、共享资源发布、共享 embedding 状态推进和结构 DDL。

这一刀的目标不是单纯加文案，而是让“哪些能力还能做、哪些必须停”成为真实可执行的系统约束。

## Acceptance criteria

- [x] **优先冻结能力矩阵接口形状**：在动手改实现前，先定义并落入 TS 类型的 capability matrix 形状（含 capability key 枚举、`allowed` 状态、可解释的 `blockedBy` 原因），并明确取代旧 `readOnly` 布尔值的迁移路径。后续 10（状态面板）直接消费这份类型，避免返工。
- [x] 离线时，本地私有 `research_session` 仍可继续写入。
- [x] 离线时，对 `ent_* / rel_* / resource_item / resource_embedding / 共享结构变更` 的写入都会被一致拒绝，并返回上述接口定义的可解释能力原因。
- [x] 现有上下文/状态接口能表达能力矩阵，而不再只有单一 `readOnly` 布尔值；旧 `readOnly` 调用点已迁移到新形状。
- [x] 回归测试覆盖 shared-write gate、research-only 的离线可写语义，以及能力矩阵接口在 capability key 全量上的拒绝原因表达。

## Blocked by

- `.scratch/sync-v2/issues/04-remote-first-sheet-ddl-via-exec-template.md`
- `.scratch/sync-v2/issues/06-shared-resource-publish-tracer.md`
- `.scratch/sync-v2/issues/07-workspace-embedding-profile-and-pending-protocol.md`
