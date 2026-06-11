Status: done
Label: needs-triage

# WP-D2-07h — EditorScreen 装配 + 路由 + electrobun 清零

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

把前面各 sub-issue 搬好的部件组装成可访问的编辑器屏幕，接路由。

- `web/legacy/screens/EditorScreen.svelte`（212 行）搬到 `web/src/screens/EditorScreen.svelte`：
  - 装配 EditorTopbar / EditorToolbar / EditorWorkbookNav / 视图（getView）/ RightPanel / 各 modal。
  - **dashboard 分支留 stub**：`WorkbookDashboardScreen` 入口先占位（"看板即将上线"），dashboard 整套拆到独立后续簇（见 umbrella Notes）。
  - `EditorTopbar.svelte`（297 行）一并搬迁接线。
- 路由：在 web SPA 路由中接入
  - `/w/:slug/wb/:workbookId` → 打开工作簿（默认 sheet）
  - `/w/:slug/wb/:workbookId/sheet/:sheetId` → 指定 sheet
  - 进入时 editorStore.loadWorkbook，切 sheet 时 switchSheet。
- **electrobun 清零**：全局 grep 删尽 `electrobun/*` import（`web/legacy/lib/rpc.ts` 的 Electroview 等），确认无残留。

## Acceptance criteria

- [ ] 访问 `/w/:slug/wb/:workbookId` 与 `.../sheet/:sheetId` → 渲染编辑器 + 加载对应 sheet（umbrella 验收 1 完整版）。
- [ ] console 无任何 electrobun import 报错（umbrella 验收 5）。
- [ ] 全仓 grep 无 `from "electrobun` / `electrobun/` 残留。
- [ ] svelte-check 0 错误（umbrella 验收 6）。
- [ ] 端到端：登录 → 选 workspace → 进工作簿 → 看到表格 → 编辑单元格直达 → 另一 tab LIVE 看到变化，全程无 console error。

## Blocked by

- 07b、07c、07d、07e、07f、07g

## Notes

- 本 issue 收口后，umbrella 07 的全部验收项达成，可关 07；剩下的 web/legacy 清删归 D2-09。
- dashboard / 资源检索窗 / 模板等其余 legacy screen 不在本簇——它们要么是后续业务簇，要么随 D2-09 一并评估删除。
