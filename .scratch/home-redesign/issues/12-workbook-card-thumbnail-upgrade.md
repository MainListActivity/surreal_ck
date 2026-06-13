## What to build

工作簿卡片网格视图中，`blank` 类型的 thumbnail（`.blank-preview`）当前仅渲染两条灰色横线，信息密度极低，与 `table`（4×3 网格预览）和 `graph`（SVG 节点图）的视觉完成度差距明显。

**改动目标（仅改 `HomeScreen.svelte` 中的 blank-preview 模板与样式）：**

将 `.blank-preview` 从两条灰横线升级为：
- 左上角一个 `<Sheet size={28}>` Lucide 图标（`color: var(--text-3)`）
- 下方三条宽度递减的细横线（模拟空白表格行），使用现有 `.blank-preview span` 样式基础扩展
- 整体背景保持 `linear-gradient(135deg, #f7f8fa, #edf0f5)`，不改变容器尺寸

这样 blank 卡片在视觉上有"这是一个表格"的语义提示，而非纯灰块。

## Acceptance criteria

- [ ] `blank` 类型 thumbnail 显示 Sheet 图标 + 三条细横线，不再是两条粗灰线
- [ ] `table` / `graph` 类型 thumbnail 不受影响
- [ ] 列表视图（`.list-preview.blank`）的图标同步更新（已有 `<Sheet>` icon，确认颜色/大小对齐）
- [ ] 卡片高度、网格列数不变
- [ ] svelte-check 无类型错误

## Blocked by

None - can start immediately
