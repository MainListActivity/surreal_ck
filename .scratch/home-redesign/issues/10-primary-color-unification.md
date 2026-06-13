## What to build

统一全页 primary color，清除当前三套蓝紫色系并存的视觉噪点：

1. **删除 AI Banner 渐变中的绿色节点**：`HomeScreen.svelte` 中 `.ai-banner` 的 `background: linear-gradient(135deg, #155eef 0%, #3b82f6 54%, #0f9f8f 100%)` 结合 HR-09 一并废弃（HR-09 完成后本条自然满足，可作为验收检查项）。

2. **右侧 AI 助手面板 chip 按钮对齐**：`AiDrawer.svelte`（或承载右侧面板的组件）中「工作簿 / 查找 / 图表」三个 chip 按钮，当前使用独立的偏紫蓝色，改为与 `SideNav` active 态一致的 `background: var(--primary-light); color: var(--primary)`，去掉独立 color 硬编码。

3. **检查并清理其余硬编码蓝色**：grep `#155eef` `#3b82f6` `#0f9f8f` `#2563eb` 等跨组件硬编码，确认是否需要提取到 CSS 变量或与现有 `var(--primary)` 对齐。`var(--primary)` 当前值为 `oklch(0.21 0.006 285.885)`（接近深蓝黑），如视觉上偏暗可在 `app.css` 中调整为更饱和蓝（如 `oklch(0.55 0.22 260)`），但需整体评估影响范围。

## Acceptance criteria

- [x] 全页不出现绿色系色值（`#0f9f8f` 或 oklch 绿色节点已删除）
- [x] AI 助手面板 chip 按钮视觉与 SideNav active 态一致，无独立偏紫蓝硬编码
- [x] 快捷操作卡片 icon 色块、tab active 下划线、view-toggle active 态均使用同一 primary token
- [x] `grep -r '#0f9f8f\|#059669\|#0f9' web/src` 无结果（绿色清零）
- [x] svelte-check 无类型错误

## Blocked by

- HR-09（AI Banner 降权重，渐变色一并废弃）
