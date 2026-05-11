Status: ready-for-agent
Label: ready-for-agent

# SYNC-003 — 同步表清单 + CHANGEFEED + `_origin_session_id` 字段 + EVENT 自动注入

## Parent

`docs/adr/sync.md`

## What to build

把同步层需要的“表级元信息”一次性铺到 schema：所有进入同步范围的表加 `CHANGEFEED 7d`、`_origin_session_id` 字段、`DEFINE EVENT` 自动注入。同时把同步范围在代码中显式声明，新增表 fail-closed。

具体范围：

- 在 `src/main/sync/scope.ts` 中维护单一权威清单 `SYNC_SCOPE`：每个同步表显式列出 `{ table, scope: 'remote' | 'local' | 'user-scoped', rowFilter?: (row) => boolean }`。未列出 = 仅本地，新增表必须显式注册才会同步。
- 同步范围参照 ADR §6（workspace、app_user、has_workspace_member、pending_workspace_member、workbook、folder、sheet、edge_catalog、mutation、snapshot、presence、dashboard_page、dashboard_view、form_definition、intake_submission、workbook_file、research_session、resource_item、resource_embedding、client_error；`ent_*` 与 `rel_*` 通过表名前缀通配；`app_setting` 走 `rowFilter` 过滤 `sensitive=true`）。
- 修改 `schema/main.surql`：对所有同步表追加 `CHANGEFEED 7d`、新字段 `_origin_session_id TYPE string`、`DEFINE EVENT` 当 `$event IN ['CREATE','UPDATE']` 且 `$after._origin_session_id = NONE` 时把 `$current_session_id` 写入。
- 修改 `src/main/services/data-table-runtime.ts` 的 `provisionEntityTable` / `provisionEntityFields`：动态创建 ent_* / rel_* 表时同步带上 CHANGEFEED、`_origin_session_id` 字段和注入 EVENT。
- 单测覆盖：（a）业务代码普通 create/update 后字段被自动填入；（b）显式写 `_origin_session_id = 'remote:xxx'` 时 EVENT 不覆盖；（c）`SHOW CHANGES` 返回的变更体中包含该字段。

仅本地表（token_store、app_meta、mastra_memory_*、mastra_workflow_run、mastra_observability_*、dashboard_result_cache、dashboard_run_log、sync_cursor、sync_dead_letter、app_setting sensitive=true 行）不加 CHANGEFEED 和 `_origin_session_id`。

## Acceptance criteria

- [ ] `src/main/sync/scope.ts` 是同步范围的唯一权威，包含动态前缀匹配（ent_*, rel_*）与 row-level filter（app_setting）。
- [ ] 所有 ADR §6 列出的同步表都带 `CHANGEFEED 7d` 与 `_origin_session_id` 字段及注入 EVENT。
- [ ] 新建的 ent_* 动态表自动带 CHANGEFEED 与 `_origin_session_id` 注入。
- [ ] 单测：普通业务写入后 `_origin_session_id = <local session>`；显式写 `remote:vs` 时不被 EVENT 覆盖。
- [ ] 单测：`SYNC_SCOPE` 未注册的新表名 isInScope() 返回 false。
- [ ] 仅本地表清单（token_store / mastra_* / sync_* 等）的回归测试：这些表没有 CHANGEFEED，schema 中也没有 `_origin_session_id`。

## Blocked by

- `.scratch/sync/issues/02-sync-meta-tables-and-session-id.md`
