Status: done
Label: done

# SHADCN-01 — Select 封装迁移（SelectMenu → shadcn Select）

## Parent

`.scratch/shadcn-migration/PRD.md`

## What to build

把手搓的 `components/SelectMenu.svelte`（351 行，自管浮层定位、键盘导航、document-pointer 外点关闭）替换为 shadcn-svelte 的 Select 封装（底层 bits-ui Select）。

走封装路线：`pnpm dlx shadcn-svelte@latest add select`，把封装层拉进 `$lib/components/ui/select/`，官方默认样式即可（视觉对齐留 SHADCN-04）。然后把 4 处复用点改为引用新封装，最后删除 `SelectMenu.svelte`。

复用点共 4 处：`features/editor/modals/ShareModal.svelte`、`features/editor/components/RecordForm.svelte`、`features/editor/tool-panels/FilterPanel.svelte`、`features/editor/tool-panels/SortPanel.svelte`。

这是封装路线在本项目的试金石——它跑通后 SHADCN-02 / 03 套路复制。

## Acceptance criteria

- [ ] `$lib/components/ui/select/` 经 CLI add 生成，官方默认样式
- [ ] 4 处复用点全部改为引用新 Select，行为等价（选中、占位、禁用、icon、空值）
- [ ] 浮层定位 / 键盘上下选择 / Escape / 外点关闭由 bits-ui 接管，不再有手搓 `updatePosition` / `handleDocumentPointer`
- [ ] `SelectMenu.svelte` 已删除，全仓无残留引用
- [ ] `pnpm --filter @surreal-ck/web run typecheck` 通过
- [ ] `pnpm --filter @surreal-ck/web run test` 通过

## Blocked by

None - can start immediately
