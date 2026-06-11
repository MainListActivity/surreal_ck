Status: done
Label: needs-triage

# WP-D2-07f — 工具条面板：Filter / Sort / Group + 工具条

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

驱动 `viewParams` 的工具面板，搬到 `web/src/features/editor/`，绑定 07a 的 editorStore：

- `EditorToolbar.svelte`（166 行）—— 工具条入口。
- `tool-panels/FilterPanel.svelte`（267 行）→ editorStore.setFilters（FilterClause[]）。
- `tool-panels/SortPanel.svelte`（198 行）→ editorStore.setSorts（SortClause[]）。
- `tool-panels/GroupPanel.svelte`（64 行）→ editorStore.setGroupBy。
- `registries/tools.ts`（07b 已搬）解析当前 activeTool。

数据侧无新增：`buildSelect` 已把 filters/sorts 编译进 SurrealQL（参数化，列名白名单防注入）。本 issue 纯组件接线 + 交互。

## Acceptance criteria

- [ ] 加筛选条件 → editorStore.setFilters → reloadRows → 直连 SELECT 带 WHERE，Grid 行更新。
- [ ] 加排序 → ORDER BY 生效。
- [ ] filterMode AND/OR 切换正确传给 `buildSelect`。
- [ ] 面板交互（增删条件行、选列、选 op、填值）有组件级测试或交互验证。
- [ ] 删除组件内所有 electrobun import。
- [ ] svelte-check 0 错误。

## Blocked by

- 07a（editorStore seam）、07c（Grid 渲染受筛选/排序影响）

## Notes

- 工具面板只产出"用户驱动的过滤选项"，不写任何 `WHERE user = $auth`——权限由 PERMISSIONS 兜底（CLAUDE.md 规则）。
- 值的类型 coerce（如 date 列填的字符串转 datetime）走 field-schema，确保 binding 类型与 schema 一致。
