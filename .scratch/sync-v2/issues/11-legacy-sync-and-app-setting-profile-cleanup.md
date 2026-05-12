Status: ready-for-human
Label: ready-for-human

# SYNCV2-011 — 旧同步路径与 `app_setting` embedding profile 收口清理

## Parent

`docs/adr/sync.md`

## What to build

把新架构落地过程中沉淀下的旧路径和旧数据一次性收口，让仓库不再保留"重建 + LIVE"模型已经放弃的双轨实现：

1. 删除 `src/main/sync/` 中残留的 `SHOW CHANGES` / remote cursor / tombstone / 补偿 `updated_at` 查询相关代码，以及只为旧路径存在的工具函数、类型和测试夹具。
2. 把 `app_setting` 里旧版"用户级 embedding profile"数据按 ADR §8 的新形态（`workspace_embedding_profile`）迁移：能映射到工作区 canonical profile 的，按 owner 写入新表；不能映射或与工作区不兼容的，明确弃用并清理。
3. 留下一份简短迁移备注，描述新旧表对应关系和不可迁移条目的处理结果。

这一刀的目的不是再加功能，而是消化前 10 个 tracer 留下的死代码和过渡数据，避免长期维护时再被旧概念误导。需要人工确认，因为它会触及 schema 数据迁移和不可回滚的清理。

## Acceptance criteria

- [ ] `src/main/sync/` 不再包含 `SHOW CHANGES`、remote cursor、tombstone、`updated_at` 补偿相关的实现代码、类型、注释或测试夹具；grep 关键词在源码树下无残留命中。
- [ ] `app_setting` 中旧版用户级 embedding profile 条目已按规则迁移到 `workspace_embedding_profile` 或显式弃用，且迁移脚本可幂等重跑。
- [ ] 迁移完成后，没有任何运行时代码还从 `app_setting` 读取 embedding profile；唯一来源是 `workspace_embedding_profile`。
- [ ] 一份简短迁移备注落入 `docs/adr/sync.md` 旁的附录或 `docs/solutions/` 对应分类，覆盖新旧映射、不可迁移条目处理和回滚边界。
- [ ] 回归测试覆盖：旧 sync 模块删除后启动重建仍按 ADR §4 收敛；迁移脚本对空库、已迁移库和混合库均幂等。

## Blocked by

- `.scratch/sync-v2/issues/02-fixed-shared-live-and-dirty-rebuild.md`
- `.scratch/sync-v2/issues/03-ent-projection-tracer.md`
- `.scratch/sync-v2/issues/05-rel-projection-and-workspace-key.md`
- `.scratch/sync-v2/issues/07-workspace-embedding-profile-and-pending-protocol.md`
- `.scratch/sync-v2/issues/08-volunteer-indexer-and-keyword-fallback.md`
