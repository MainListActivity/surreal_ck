Status: done
Label: needs-triage

# WP-D2-07b — editorUi 状态 + Workbook/Sheet 导航搬迁

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

两块互相独立、都靠后续视图，先做掉：

### 1. editorUi（纯 UI 状态）

- `web/legacy/features/editor/lib/editor-ui.svelte.ts` 搬到 `web/src/features/editor/lib/editor-ui.svelte.ts`。
- 它只维护「哪个 view / panel / tool 打开、选中行、剪贴板状态」等 UI 态，几乎不碰数据层——**近乎原样搬**，只改类型 import 路径（指向 `@surreal-ck/shared/*` 与新 editor-store）。
- 顺带搬 `registries/{views,tools,panels,menu}.ts`、`lib/{cell-style,field-type-meta,derived-columns}.ts`（纯逻辑/注册表）。

### 2. Workbook/Sheet 导航

- `web/legacy/lib/workbooks.svelte.ts` 重写为直连：`listWorkbooks / listFolders` → `SELECT * FROM workbook` / `SELECT * FROM sheet WHERE workbook = $wb ORDER BY ...`（folder 表若无则简化）。
- 创建/重命名/移动 workbook：管理员才有 DDL/写权限——走 `createRecord`/`updateRecord`，权限错误经 `describeWriteError`。
- 组件 `EditorWorkbookNav.svelte`（396 行）+ `EditorSheets.svelte`（151 行）搬到 `web/src/features/editor/`，绑定新 workbooks store。

## Acceptance criteria

- [ ] editorUi + registries + lib 纯逻辑搬迁后，相关既有测试全过；新增的纯逻辑（derived-columns 等）补单测。
- [ ] workbooks store 直连读写有单测（fake `SurrealConn`）。
- [ ] EditorWorkbookNav / EditorSheets 渲染工作簿与 sheet tab，切 sheet 调 editorStore.switchSheet。
- [ ] 删除组件内所有 electrobun import。
- [ ] svelte-check 0 错误。

## Blocked by

- 07a（editorStore seam）

## Notes

- workbook 列表「最近打开」等 scope 信息属于 Workspace Scope Module（后端），不要在 workbook 表里塞；纯展示用 sheet/workbook 直连即可。
