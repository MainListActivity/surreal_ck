Status: done
Label: done

# SYNCV2-010 — 同步状态面板 v2：投影健康与手动重建

## Parent

`docs/adr/sync.md`

## What to build

把旧的 cursor/dead-letter 状态 UI 替换成新架构下真正有意义的同步健康面板：展示 remote 连通性、最后重建时间、dirty projection/structure shadow 状态、当前是否正在重建，并提供手动重建入口。

这一刀是用户可感知的收口。完成后，用户和维护者能观察“本地派生状态是否健康”，而不是观察已经被 ADR 放弃的旧同步内部机制。

## Acceptance criteria

- [x] 后端 SyncStatusV2DTO 与 getSyncStatusV2 RPC 已暴露 remote 连通性、lastRebuildAt 与 rebuildInProgress。
- [x] dirtyStructureShadow 字段已透出，runtime state 与 DTO 同步更新。
- [x] 后端 triggerSyncRebuild RPC 已就绪，UI 可调用触发重建。
- [x] 前端 SyncStatusBar 已重写为消费 SyncStatusV2DTO；主面板展示 online / dirtyStructureShadow / lastRebuildAt / rebuildInProgress，重建按钮调用 triggerSyncRebuild；旧 cursor/dead-letter 列表从主体移除。

## Blocked by

- `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
- `.scratch/sync-v2/issues/03-ent-projection-tracer.md`
- `.scratch/sync-v2/issues/05-rel-projection-and-workspace-key.md`
- `.scratch/sync-v2/issues/08-volunteer-indexer-and-keyword-fallback.md`
- `.scratch/sync-v2/issues/09-offline-capability-matrix-and-shared-write-gate.md`
