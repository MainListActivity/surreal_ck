## What to build

右侧面板当前将「动态 feed」与「AI 助手」两个完全不同的功能域并排渲染，缺少视觉隔断，纵深层次模糊。

**改动目标：**

1. **面板分区背景差异化**：动态 feed 区域（顶部 tab + 列表）保持 `var(--surface)`；AI 助手聊天区域改为 `var(--bg)`（略深）或加 `border-top: 1px solid var(--border)` 明确切割线，使两个功能区层次清晰。

2. **AI 助手标题区独立样式**：「AI 助手」标题行（含关闭按钮）加 `padding-bottom`+ 细分割线，与聊天内容区视觉分离；当前标题行与 feed 标题行视觉语言雷同，难以区分区域归属。

3. **错误/状态提示上移**：「AI chat service is not wired up in this deployment」提示当前浮在输入框上方空白处，改为紧贴 AI 助手标题区下方，视觉归属更清晰。

涉及文件：`AiDrawer.svelte`（或右侧面板容器组件）、`ActivityPanel.svelte`（如已拆分）。

## Acceptance criteria

- [x] 动态 feed 区与 AI 助手区之间有明确视觉分隔（分割线 or 背景差异）
- [x] AI 助手标题行样式与动态 feed tab 行视觉差异可辨（字重/背景/间距至少一项不同）
- [x] 状态/错误提示归属于 AI 助手标题区下方，不浮于输入框上方空白
- [x] 面板整体宽度不变，不影响主内容区布局
- [x] svelte-check 无类型错误

## Blocked by

None - can start immediately
