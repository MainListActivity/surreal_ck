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
- [ ] 订阅集变化按差量处理：新增 `rel_*` 做单表全量 + 起 `LIVE`，移除 `rel_*` 停 `LIVE` + 按 `workspace` 归属键清本地投影，**未变化关系表保留现有订阅，不触发全局重建**。
- [ ] 大 `rel_*` 表（万行级）重建不阻塞主进程 RPC：重建期间高层读路径仍可响应，重建以分批或流式方式落地。
- [ ] 回归测试覆盖关系表重建、在线增量、归属键、订阅集差量热刷新、大表重建期间的读可用性，以及 metadata 移除后的本地 purge。

## Blocked by

- `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
- `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
- `.scratch/sync-v2/issues/04-remote-first-sheet-ddl-via-exec-template.md`
