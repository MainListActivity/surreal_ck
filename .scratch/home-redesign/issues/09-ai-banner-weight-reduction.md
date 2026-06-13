## What to build

将 `HomeScreen.svelte` 中的 AI Banner 从全宽渐变大横幅降权为收纳式细条带，释放主内容区视觉空间，使快捷操作三格成为真正的视觉焦点。

当前 `.ai-banner` 高 96px、蓝绿渐变背景、强阴影，视觉权重超过了快捷操作区，但 AI Banner 是辅助入口而非核心功能——两者的视觉权重倒置。

**改动目标：**
- `.ai-banner` 最小高度从 96px 降至 ~52px，去掉 `box-shadow`
- 背景改为 `var(--primary-light)`（浅蓝），文字改为 `var(--primary)`——与整体色系一致，不再突兀
- 保留布局：左侧 icon + 一句话说明，右侧"开始对话" chip
- 将 banner 移至快捷操作三格**下方**（或保持上方但视觉降噪），让快捷操作卡片居首

## Acceptance criteria

- [ ] `.ai-banner` 高度 ≤ 56px，无大面积渐变色块，无强投影
- [ ] banner 背景使用 `var(--primary-light)`，文字/icon 使用 `var(--primary)`
- [ ] "开始对话"按钮功能不变（触发 `onopenaichat`）
- [ ] 快捷操作三格在视觉上位于 greeting 正下方，AI Banner 在其下方或视觉权重明显低于快捷操作
- [ ] svelte-check 无类型错误

## Blocked by

None - can start immediately
