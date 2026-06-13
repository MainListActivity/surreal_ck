## What to build

统一 icon 系统，将业务 UI 从自制 `Icon.svelte` + 手写 `icons.ts` 全面迁移到 `@lucide/svelte`，同时将品牌 logo 从 CSS 拼图替换为 `assets/wordmark.svg`。

### Wordmark 替换

`Logo.svelte` 当前用纯 CSS（四个方块 + 文字）拼接 logo。替换为直接引用 SVG 文件：
- 将 `assets/wordmark.svg` 和 `assets/wordmark-dark.svg` 复制到 `web/src/assets/`
- `Logo.svelte` 改为 `<img src={wordmarkSvg} alt="品牌名" />`，通过 Vite 静态资源导入
- 按当前主题（light/dark）切换 `wordmark.svg` / `wordmark-dark.svg`
- 保留 `size` prop 控制高度（`md` = 24px，`sm` = 18px），宽度 auto

### Icon 系统迁移

当前状态：`web/src/lib/icons.ts`（约 50 个手写 SVG path）+ `web/src/components/Icon.svelte`，被业务 UI 全局使用。`@lucide/svelte` 已安装，目前只在 shadcn-svelte 底层组件（`ui/` 目录）中使用。

迁移策略：
- 删除 `web/src/lib/icons.ts` 和 `web/src/components/Icon.svelte`
- 全局搜索所有 `<Icon name="..." />` 用法，逐一替换为对应的 `@lucide/svelte/icons/*` 具名 import
- icon 命名对照（示例）：`home` → `Home`，`settings` → `Settings`，`bell` → `Bell`，`search` → `Search`，`logout` → `LogOut`，`plus` → `Plus`，`chevronDown` → `ChevronDown`，`trash` → `Trash2`，`folder` → `Folder`，`hash` → `Hash`，`coins` → `Coins`，`network` → `Network`，`grid` → `Grid3x3` 等
- shadcn-svelte 底层 `ui/` 组件已经是 lucide，不需要改动
- 首页重构新增所需 icon（通知铃铛 `Bell`、workspace 切换箭头 `ChevronsUpDown`、固定 `Pin`、活动流 `Activity` 等）直接用 lucide，不走旧 `Icon.svelte`

每个 lucide 组件通过 `size`、`color`、`strokeWidth` prop 控制样式，接口与现有 `Icon.svelte` 基本兼容，替换时按调用处实际传参调整。

## Acceptance criteria

- [x] `Logo.svelte` 渲染 `wordmark.svg` 图片而非 CSS 拼图，light/dark 主题下切换正确的变体
- [x] `web/src/lib/icons.ts` 和 `web/src/components/Icon.svelte` 已删除
- [x] 全局无 `<Icon name="..." />` 残留
- [x] 所有原 `Icon` 使用处已替换为对应 lucide 组件，视觉输出一致
- [x] shadcn-svelte `ui/` 组件不受影响
- [x] `svelte-check` 和 `tsc` 无类型错误
- [x] 本地 dev server 启动后各页面 icon 渲染正常，无缺图

## Blocked by

None — can start immediately（建议优先完成，HR-01 开始前合入）
