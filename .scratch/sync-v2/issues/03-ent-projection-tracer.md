Status: done
Label: done

# SYNCV2-003 — `sheet` 驱动的 `ent_*` 投影 tracer

## Parent

`docs/adr/sync.md`

## What to build

用一张动态实体表打通 metadata-driven 投影链路：`sheet.table_name + column_defs` 作为唯一结构真相，驱动本地 `ent_*` 投影的创建、重建、读取和在线增量更新。

这一刀需要证明两件事：第一，动态实体表不再依赖 remote `INFO FOR DB`；第二，编辑器等高层读路径仍然只读本地投影，而不是回退成 remote 查询。

## Acceptance criteria

- [x] 当用户可见的 `sheet` 声明了一张 `ent_*` 表时，系统会按其 metadata 重建本地投影并恢复数据。
- [x] 至少一条现有实体数据读路径继续从本地 `ent_*` 投影读取，且读到的是重建后的数据。
- [x] 对应 `sheet` metadata 变更后，投影结构和订阅集会按 metadata 更新，不依赖 remote DDL introspection。
- [x] 订阅集变化按差量处理：新增表做单表全量 + 起 `LIVE`，移除表停 `LIVE` + 清本地投影，**未变化表保留现有订阅，不触发全局重建**。
- [x] 大 `ent_*` 表（万行级）重建不阻塞主进程 RPC：重建期间高层读路径仍可响应，重建以分批或流式方式落地。
- [x] 回归测试覆盖 metadata 驱动的建表/重建、在线增量、订阅集差量热刷新和大表重建期间的读可用性。

## Blocked by

- `.scratch/sync-v2/issues/01-fixed-shared-shadow-bootstrap.md`
- `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
