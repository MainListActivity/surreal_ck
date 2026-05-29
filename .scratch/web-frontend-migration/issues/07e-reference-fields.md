Status: needs-triage
Label: needs-triage

# WP-D2-07e — 引用字段（reference）直连化

## Parent

`.scratch/web-frontend-migration/issues/07-workbook-ui-migrate.md`（umbrella）

## What to build

引用是表格核心字段类型之一（`fieldType: "reference"`，目标 `app_user` 或 `ent_xxx`）。
legacy 靠后端 `appApi.resolveReferences` 批量解析展示值，本 issue 改成浏览器直连跨表 SELECT。

- `web/legacy/lib/reference-cache.svelte.ts` 重写为直连：
  - `resolveReferences(ids)` → 按目标表分组 `SELECT id, <displayKey> FROM type::table($tb) WHERE id INSIDE $ids`（参数化）。
  - 缓存 + 批量合并逻辑保留；`collectReferenceIdsFromValues` 纯逻辑原样搬。
  - displayKey 回退链（name → display_name → email → id）保留。
- `searchReferenceCandidates` → 直连 `SELECT ... WHERE <displayKey> CONTAINS $q LIMIT N`。
- 组件搬到 `web/src/features/editor/`：
  - `components/ReferenceCell.svelte`（144 行）
  - `panels/ReferencePanel.svelte`（153 行）
  - `web/legacy/components/RecordPicker.svelte` → `web/src/components/RecordPicker.svelte`

## Acceptance criteria

- [ ] reference-cache 直连解析 + 缓存有单测（fake `SurrealConn`，覆盖批量分组 / displayKey 回退 / 候选搜索）。
- [ ] GridView / FormView 中引用单元格显示目标记录的展示值，不是裸 RecordId。
- [ ] 引用选择器（RecordPicker）搜索候选 → 直连 SELECT，选中写回 editorStore（值为 RecordId，validate 走 field-schema 的 `recordIdBelongsToTable`）。
- [ ] 删除组件内所有 electrobun import。
- [ ] svelte-check 0 错误。

## Blocked by

- 07a（editorStore seam）、07c（Grid 引用单元格）

## Notes

- 引用写入值必须是合法 RecordId 且属于目标表——`shared/src/field-schema.ts` 的 `validateGridFieldValue` 已校验，直接复用。
- 多选引用是 `array<record<...>>`，coerce/validate 已在 field-schema 处理。
