Status: done
Label: done

# SHADCN-03 — RecordPicker 外壳迁移（→ bits-ui Combobox）

## Parent

`.scratch/shadcn-migration/PRD.md`

## What to build

把 `components/RecordPicker.svelte`（527 行，手搓浮层定位 10 处、键盘 4 处、aria 10 处）的**交互外壳**迁到 shadcn-svelte 封装，底层用 bits-ui **Combobox**（输入框 + 浮层候选 + 键盘选择，正对引用选择器形态，比手拼 Popover+Command 更对口）。

走封装路线：`pnpm dlx shadcn-svelte@latest add command`（及 Combobox 所需依赖），官方默认样式（视觉对齐留 SHADCN-04）。

**只换外壳，业务内核原样保留**：
- 接管给 bits-ui 的：浮层定位、键盘上下/回车选择、Escape、外点关闭、aria。
- **保留不动**：reference-cache（resolveReferences）、按表分组搜索候选、displayKey 回退、RecordId 边界处理（`web/src/lib/record-id.ts`，见 [[record-id-boundary-rule]]）。

被 3 处引用：`features/editor/components/RecordForm.svelte`、`features/editor/views/GridView.svelte`、`lib/reference-cache.svelte.ts`。

最核心交互、回归面最大——与 01/02 隔离，单独验证单独合。

## Acceptance criteria

- [ ] RecordPicker 浮层 / 键盘 / 外点 / aria 由 bits-ui Combobox 接管，删除对应手搓逻辑
- [ ] reference-cache、按表搜索、displayKey 回退、RecordId 边界逻辑保持不变
- [ ] `reference-cache.test.ts` 等现有覆盖业务内核的测试不改而仍通过
- [ ] 3 处引用点行为等价（搜索、选中、显示已选、清除）
- [ ] `pnpm --filter @surreal-ck/web run typecheck` 通过
- [ ] `pnpm --filter @surreal-ck/web run test` 通过

## Blocked by

- `.scratch/shadcn-migration/issues/01-select-shadcn.md`（验证封装路线后套路复制；与 SHADCN-02 可并行）
