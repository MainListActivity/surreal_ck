Status: ready-for-agent
Label: ready-for-agent

# SYNCV2-005 — `edge_catalog` 驱动的 `rel_*` 投影与 `workspace` 归属键

## Parent

`docs/adr/sync.md`

## What to build

把动态关系表纳入同一套 metadata-driven 投影模型：`edge_catalog.rel_table + edge_props + from/to` 作为结构真相，并给所有可同步 `rel_*` 统一补上 `workspace` 归属键，作为订阅、清理和本地投影恢复的稳定边界。

完成后，关系表不再靠端点推导归属，也不再需要单独的 remote introspection 兜底。

## Acceptance criteria

- [ ] 可见 `edge_catalog` 声明的 `rel_*` 表能从 metadata 重建出本地投影并恢复数据。
- [ ] `rel_*` 投影统一带有稳定的 `workspace` 归属信息，可用于本地清理和投影管理。
- [ ] `edge_catalog` 变化会驱动 `rel_*` 订阅集新增、移除和本地投影清理。
- [ ] 回归测试覆盖关系表重建、在线增量、归属键和 metadata 移除后的本地 purge。

## Blocked by

- `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
- `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
- `.scratch/sync-v2/issues/04-remote-first-sheet-ddl-via-exec-template.md`
