Status: done
Label: done

# AI-001 — 全局 AI 抽屉：启动器 + 非模态面板 UI 骨架

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

在所有认证后页面添加全局 AI 启动器入口（复用已有 `GlobalAiLauncher` 组件骨架），点击后打开一个非模态 AI 抽屉。

抽屉要求：
- 不渲染全屏遮罩层，不拦截抽屉外的指针事件，主应用表格/导航/仪表盘可正常操作
- 包含：上下文提示区（占位，AI-002 填充）、消息列表区（占位）、提示词输入框、发送按钮、关闭按钮
- 无模型配置时，输入区展示"AI 尚未配置，请前往设置"降级提示
- 抽屉开关状态持久存于全局 app state，页面切换后保持打开/关闭

不包含：真实 AI 消息收发（AI-003）、上下文数据联动（AI-002）、sidecar 窗口（AI-009）。

## Acceptance criteria

- [x] 认证后所有页面（HomeScreen、EditorScreen、DashboardScreen 等）均可看到 AI 启动器入口
- [x] 点击启动器打开抽屉，再次点击或点击抽屉内关闭按钮可关闭
- [x] 抽屉打开时，主应用表格单元格、导航侧边栏、仪表盘小部件的点击和滚动均不受阻塞
- [x] 抽屉不渲染背景遮罩（无 `pointer-events: all` 全屏覆盖层）
- [x] 无 AI 模型配置时，输入区显示降级提示而非报错
- [x] 页面路由切换后抽屉保持原有开关状态

## Implementation notes

大部分功能在开发分支中已完整实现，本 issue 唯一的代码变更是将抽屉开关状态从 `GlobalAiLauncher` 组件局部 `$state` 提升到 `appState.aiDrawerOpen`（全局单例），使其在路由切换后保持。

- `src/renderer/lib/app-state.svelte.ts`：新增 `aiDrawerOpen`、`toggleAiDrawer()`、`setAiDrawerOpen()`
- `src/renderer/components/GlobalAiLauncher.svelte`：改用 `appState.aiDrawerOpen` / `appState.toggleAiDrawer()` / `appState.setAiDrawerOpen(false)`

## Blocked by

None — can start immediately
