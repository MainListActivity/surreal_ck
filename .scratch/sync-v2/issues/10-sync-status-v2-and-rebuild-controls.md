Status: ready-for-agent
Label: ready-for-agent

# SYNCV2-010 — 同步状态面板 v2：投影健康与手动重建

## Parent

`docs/adr/sync.md`

## What to build

把旧的 cursor/dead-letter 状态 UI 替换成新架构下真正有意义的同步健康面板：展示 remote 连通性、最后重建时间、dirty projection/structure shadow 状态、当前是否正在重建，并提供手动重建入口。

这一刀是用户可感知的收口。完成后，用户和维护者能观察“本地派生状态是否健康”，而不是观察已经被 ADR 放弃的旧同步内部机制。

## Acceptance criteria

- [ ] UI 能展示 remote 连通性、最近一次成功重建时间和当前是否处于重建中。
- [ ] 当结构影子库或投影数据区被标记为 dirty 时，UI 会明确暴露异常状态，而不是继续显示“已同步”。
- [ ] 用户可以从 UI 主动触发重建，并看到状态恢复过程。
- [ ] 旧的 cursor/dead-letter 导向表述不再作为主状态模型继续暴露。

## Blocked by

- `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
- `.scratch/sync-v2/issues/03-ent-projection-tracer.md`
- `.scratch/sync-v2/issues/05-rel-projection-and-workspace-key.md`
- `.scratch/sync-v2/issues/08-volunteer-indexer-and-keyword-fallback.md`
- `.scratch/sync-v2/issues/09-offline-capability-matrix-and-shared-write-gate.md`
