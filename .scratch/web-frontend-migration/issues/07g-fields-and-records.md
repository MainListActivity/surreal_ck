Status: needs-triage
Label: needs-triage

# WP-D2-07g — 字段管理 + 记录详情/表单/弹窗

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

两组绑 editorStore 的 UI：字段管理（DDL）与记录编辑（DML）。

### 字段管理（用 `defineField`）

- `modals/FieldsModal.svelte`（688 行）+ `tool-panels/FieldManagerPanel.svelte`（364 行）搬到 `web/src/features/editor/`。
- 加字段 → `workbook-data.defineField(conn, tableName, column)`（DEFINE FIELD）。
- 管理员放行；普通成员被引擎拒 → `describeWriteError` 已翻成"仅管理员可修改表结构"，UI 直接展示（对应 umbrella 验收 3 + 4，数据层已就位，本 issue 接 UI 入口 + 加字段后刷新列）。
- 改字段类型/约束的 DDL（ALTER/REMOVE）若 legacy 有，按需在 `workbook-data` 补对应纯函数（沿用 `buildSurrealFieldSchema` 口径）。

### 记录详情 / 表单 / 弹窗

- `panels/DetailPanel.svelte`（124 行）、`components/RecordForm.svelte`（316 行）。
- `modals/AddRecordModal.svelte`（123 行）、`modals/LeaveDraftModal.svelte`（147 行）、`modals/ShareModal.svelte`（120 行）。
- `panels/{ChangesPanel,AiPanel}.svelte`（各 5 行占位）、`RightPanel.svelte`（90 行，panel 容器）。
- 全部绑 editorStore / editorUi；保存走 saveRows，草稿晋升走 record-drafts。

## Acceptance criteria

- [ ] 管理员经 UI 加字段 → DEFINE FIELD 成功，刷新后列出现（umbrella 验收 3）。
- [ ] 普通成员经 UI 加字段 → 被拒，UI 给出明确中文错误（umbrella 验收 4）。
- [ ] DetailPanel / RecordForm 编辑单条记录 → saveRows 直达；草稿未保存离开 → LeaveDraftModal 拦截。
- [ ] AddRecordModal 新建记录 → CREATE 直达。
- [ ] 删除组件内所有 electrobun import。
- [ ] svelte-check 0 错误。

## Blocked by

- 07a（editorStore seam）、07c（Grid 加字段后列刷新）、07e（RecordForm 内引用输入）

## Notes

- ShareModal 若依赖后端分享 endpoint（已废弃）：MVP 内先降级为 stub 或移除分享入口，不要为它新增后端代理。
- AiPanel 真正接线属 D2-08（AI 抽屉），本 issue 只搬占位容器。
