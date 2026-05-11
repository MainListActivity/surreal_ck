Status: ready-for-agent
Label: ready-for-agent

# SYNC-007 — 字段级 MERGE 扩展到所有同步表（含 ent_* 与 RELATION）

## Parent

`docs/adr/sync.md`

## What to build

把 SYNC-005 / SYNC-006 在 `workspace` 上验证过的字段级 MERGE + 未推送字段保护扩展到 `SYNC_SCOPE` 中的所有同步表，特别覆盖：

- `ent_*` 动态实体表（含可选字段、option<record<>> 引用、计算字段）
- `rel_*` / `has_workspace_member` RELATION 表（CREATE 用 `RELATE in->edge->out CONTENT { ... }`，不能用 `db.create`）
- 含 FLEXIBLE object 字段的表（`mutation.params`, `snapshot.layout`, `presence.cursor`, `dashboard_view.builder_spec` 等）：MERGE 时对象字段整段替换还是深合并？本 issue 决策为整段替换（语义清晰、CHANGEFEED 也提供整段值），并在单测中固化。

具体范围：

- 在 `local-to-remote-worker` 与 `remote-to-local-worker` 中以 `SYNC_SCOPE` 为驱动枚举所有同步表，每张表使用一个统一的“类型 → 操作”映射器：
  - 普通表 → `db.create / merge / delete`
  - RELATION 表 → `RELATE` / `UPDATE` / `DELETE`（in/out 字段需要从 CHANGEFEED 变更体恢复）
- ent_* / rel_* 通过表名前缀匹配，运行时枚举 localdb 现存表（`INFO FOR DB`）。
- 单测覆盖：
  - 单个 ent_* 表的 create/merge/delete。
  - RELATION 表 `has_workspace_member` 的 RELATE / DELETE。
  - FLEXIBLE object 字段（`mutation.params`）整段替换。
  - 两台设备（mock 两个 localdb 共享 mock 远端）并发改同一行不同字段，最终两端一致且没有字段被 clobber。

## Acceptance criteria

- [ ] worker 在不知道具体表名的情况下，通过 `SYNC_SCOPE` + `INFO FOR DB` 枚举 ent_* / rel_* 正确处理。
- [ ] RELATION 表 RELATE 的 in/out 字段在推送时从 CHANGEFEED 变更体正确还原。
- [ ] FLEXIBLE object 字段的整段替换语义有单测固化。
- [ ] 两台设备并发改不同字段的场景：双向 worker 跑完后两端字段集合一致，无字段丢失。
- [ ] 已有的非同步业务表（token_store / mastra_*）不会被枚举到。

## Blocked by

- `.scratch/sync/issues/06-downlink-tracer-workspace.md`
