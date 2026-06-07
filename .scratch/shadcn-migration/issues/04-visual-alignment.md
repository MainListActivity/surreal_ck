Status: ready-for-agent
Label: ready-for-agent

# SHADCN-04 — 视觉对齐收尾（官方默认 → button 规范）

## Parent

`.scratch/shadcn-migration/PRD.md`

## What to build

SHADCN-01/02/03 拉进来的封装都用了官方默认样式。本 issue 统一把它们对齐到项目里 `button` 已建立的定制规范，消除"Select 像官方 shadcn、button 像本项目定制"的视觉割裂。

对齐参照点（`$lib/components/ui/button/button.svelte` 的 `buttonVariants`）：
- 紧凑 size 体系（如 `xs` / `icon-xs` / `icon-sm`，高度 h-6/h-7/h-8 量级）
- `active:not-aria-[haspopup]:translate-y-px` 按压反馈
- `aria-expanded:bg-muted` / `aria-expanded:text-foreground` 展开高亮
- 圆角与 svg size 约定

逐个扫 Select / Dialog / AlertDialog / DropdownMenu / Combobox 封装，按上述规范微调。**单独 commit，不与行为迁移混 diff。** 全程只动 `$lib/components/ui/**` 的 class，不碰业务逻辑。

## Acceptance criteria

- [ ] 各新封装的 size / 按压 / aria-expanded 高亮 / 圆角与 button 规范一致
- [ ] light / dark 两套主题下外观一致（走 app.css 变量，不硬编码颜色）
- [ ] 仅改 `$lib/components/ui/**` 样式 class，无业务逻辑改动
- [ ] `pnpm --filter @surreal-ck/web run typecheck` 通过

## Blocked by

- `.scratch/shadcn-migration/issues/01-select-shadcn.md`
- `.scratch/shadcn-migration/issues/02-dialog-and-switcher.md`
- `.scratch/shadcn-migration/issues/03-recordpicker-shell.md`
