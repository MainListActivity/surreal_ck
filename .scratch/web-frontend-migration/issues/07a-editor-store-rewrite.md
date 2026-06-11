Status: done
Label: needs-triage

# WP-D2-07a — editorStore 重写到直连数据层（迁移 seam）

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## 背景

D2-07 的直连数据层（`web/src/lib/workbook-data.ts` + `SurrealConn` 扩
query/liveTable/updateRecord/createRecord）已 TDD 完工。组件层全部绑定在
legacy `web/legacy/lib/editor.svelte.ts` 的 `editorStore` 上。本 issue 把
`editorStore` 重写到 `workbook-data.ts` 之上，作为后续所有组件平滑迁移的**唯一 seam**。

## What to build

- 新建 `web/src/lib/editor-store.svelte.ts`，**保持对组件暴露的公共面与 legacy 尽量一致**：
  - state：`loading / saving / error / saveError / activeSheetId / columns / rows / viewParams / draftsBySheet`
  - 方法：`loadWorkbook / reloadRows / switchSheet / setFilters / setSorts / setHiddenFields / setGroupBy / saveRows / saveFromSource / deleteRows / insertBlankRows / duplicateRowAsDraft`
  - `tableViewAdapter`：`visibleRows / visibleColumns / renderers / actions / getColumn / coerceValue / validateValue / emptyValues`
- 数据读写改走 `workbook-data.ts`：
  - `loadWorkbook / reloadRows` → `loadSheet(conn, sheet, viewParams, page)`；分页用 LIMIT/START，不一次 SELECT 整表。
  - `saveRows / saveFromSource` → `saveCells`；`deleteRows` → 新增 `workbook-data.deleteRows`（DELETE by RecordId）。
  - `sheet` 的 `tableName` + `columns` 从 sheet 记录读（`SELECT * FROM sheet WHERE workbook = $wb`）。
- drafts 逻辑：`web/legacy/lib/record-drafts.ts` 是纯逻辑（仅类型 import），**原样搬到 `web/src/lib/record-drafts.ts`**，editorStore 复用。
- `getSurreal()` 来自 `web/src/lib/surreal.ts`；workspace/db 由 `workspace-store` 提供。

## Acceptance criteria

- [ ] `editor-store.svelte.ts` 单测覆盖 load/save/delete/draft 晋升/viewParams 变更（用 fake `SurrealConn`，参考 `workbook-data.test.ts` 的 fakeConn）。
- [ ] `deleteRows` 在 `workbook-data.ts` 中 TDD 补齐（DELETE 走 RecordId，权限错误经 `describeWriteError`）。
- [ ] `record-drafts.ts` 搬迁后其既有 `.test.ts`（若有）全过。
- [ ] 公共面与 legacy 对齐：后续组件迁移只需改 import 路径，不需改调用形态。
- [ ] svelte-check 0 错误。

## Blocked by

- D2-07 数据层（已完工）

## Notes

- 不要把 `loadWorkbook` 里 dashboard 分支搬进来——dashboard 拆到独立后续簇（见 umbrella）。
- 切 workspace 时 editorStore 要重置（drafts 丢弃、LIVE 退订），与 `workspace-store` 的 enter/leave 对齐。
