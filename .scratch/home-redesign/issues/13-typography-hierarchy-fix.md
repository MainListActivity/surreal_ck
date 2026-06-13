## What to build

当前页面字体层级不足，扫视路径不清晰：

1. **动态 feed 时间戳层级消失**：`ActivityPanel.svelte`（或右侧 feed 组件）中时间戳（"2小时前"、"昨天"、"3天前"）与正文同色，改为 `color: var(--text-3); font-size: 11px`，使姓名/动作与时间形成明确主次。

2. **首页 h1 与 Banner strong 字号差不足**：`HomeScreen.svelte` 中 `.workspace-title`（`font-size: 22px`）与 `.ai-banner strong`（`font-size: 16px`）差距仅 6px，结合 HR-09 Banner 降权后，h1 可升至 `24px` 或加 `letter-spacing: -0.3px` 使标题更具分量。

3. **卡片元数据区（card-meta）时间戳**：`HomeScreen.svelte` `.card-meta` 中 `formatWorkbookUpdatedAt` 的输出已是 `var(--text-3)` + `font-size: 11px`，确认样式正确（验收检查项，无需修改）。

4. **动态 feed 条目正文**：动作描述文字（"添加了 12 条记录"）保持 `var(--text-1)` / `13px`，人名加 `font-weight: 600`，使人名与动作描述有轻微层次区分。

## Acceptance criteria

- [ ] 动态 feed 时间戳 `color: var(--text-3); font-size: 11px`，与正文明显区分
- [ ] 动态 feed 条目人名 `font-weight: 600`，动作描述 `font-weight: 400`
- [ ] 首页 h1 `.workspace-title` font-size ≥ 24px 或视觉上明显重于 banner/快捷操作标题
- [ ] 卡片 `.card-meta` 时间戳已为浅色小字（验收确认，无需改动）
- [ ] svelte-check 无类型错误

## Blocked by

- HR-09（Banner 降权后 h1 与 banner 的相对大小才有意义重新评估）
