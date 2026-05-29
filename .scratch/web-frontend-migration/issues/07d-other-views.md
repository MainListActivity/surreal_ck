Status: needs-triage
Label: needs-triage

# WP-D2-07d — 其余视图：Form / Gallery / Kanban

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

把 Grid 之外的三个视图搬到 `web/src/features/editor/views/`，全部绑定 07a 的 editorStore，复用 07b 已搬的 `registries/views.ts`：

- `FormView.svelte`（793 行）—— 表单录入视图，新建/编辑单条记录走 editorStore.actions.saveRows（CREATE/UPDATE）。
- `GalleryView.svelte`（122 行）—— 卡片视图，绑定 `tableViewAdapter.renderers`。
- `KanbanView.svelte`（131 行）—— 看板视图，按 single_select 列分组（前端分组，groupBy 在 viewParams）。

## Acceptance criteria

- [ ] 三个视图都能从 editorStore 渲染当前 sheet 的行/列。
- [ ] FormView 新建记录 → CREATE 直达 SurrealDB；编辑 → UPDATE 直达。
- [ ] 视图切换（grid/form/gallery/kanban）经 editorUi.view，registries/views 正确解析。
- [ ] 删除组件内所有 electrobun import。
- [ ] svelte-check 0 错误。

## Blocked by

- 07a（editorStore seam）、07c（Grid 跑通验证主路径后再铺开其余视图）

## Notes

- FormView 内嵌的引用字段输入依赖 07e（引用字段）；本 issue 先把引用输入留 stub 或只读，07e 接通。
