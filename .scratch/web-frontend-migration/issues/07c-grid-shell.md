Status: needs-triage
Label: needs-triage

# WP-D2-07c — Grid 外壳（RevoGrid + Vite worker）+ GridView

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

表格的核心渲染路径，是整个编辑器的"看得见"的部分。

- `web/legacy/features/grid/Grid.svelte`（203 行，`@revolist/svelte-datagrid` 封装）搬到 `web/src/features/grid/Grid.svelte`。
  - 去掉 `import type { CreditorRow }` 这类 mock 类型，改用 `GridRow` / `GridColumnDef`。
- `web/legacy/features/editor/views/GridView.svelte`（1069 行，最大单文件）搬到 `web/src/features/editor/views/`：
  - 绑定 07a 的 editorStore：`visibleRows` / `visibleColumns` → RevoGrid source/columns。
  - 单元格编辑 commit → `editorStore.actions.saveRows`（直连 UPDATE）。
  - 行选中 / 插入空行 / 复制为草稿 → editorStore actions。
- **Vite 8 RevoGrid worker / 静态资源路径确认**（PRD 风险项）：RevoGrid 是 Web Component，确认在 Vite 8 standalone web 构建下 worker 正常加载；若有 polyfill 问题按 issue 07 Notes 单独立 issue。
- LIVE 实时更新：GridView 在 onMount 调 `subscribeLive(conn, sheet, {onUpsert, onRemove})` 驱动 editorStore.rows，onDestroy 退订。

## Acceptance criteria

- [ ] 访问表格编辑器 → RevoGrid 渲染 + 从 SurrealDB SELECT 加载行（对应 umbrella 验收 1）。
- [ ] 单元格编辑 → SurrealDB UPDATE 直达，无后端跳跃（umbrella 验收 2 上半）。
- [ ] 另开一个 tab 编辑同表 → 本 tab LIVE 订阅立即看到变化（umbrella 验收 2 下半）。
- [ ] RevoGrid worker 在 dev + build 两种模式下都正常，console 无 worker 加载错误。
- [ ] 删除组件内所有 electrobun import。
- [ ] svelte-check 0 错误。

## Blocked by

- 07a（editorStore seam）

## Notes

- GridView 是最大文件，迁移时优先保证渲染 + 编辑 + LIVE 三条主路；筛选/排序/分组工具条交互在 07f 接 viewParams。
- 滚动加载用 LIMIT + START（已在 `buildSelect` 支持），切忌一次 SELECT 整表。
