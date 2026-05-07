Status: ready-for-human
Label: ready-for-human

# AI-009 — Sidecar 窗口：Electrobun 第二窗口磁吸 AI 面板

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

将 AI 抽屉从内嵌 WebView 层升级为独立的 Electrobun sidecar 窗口，使其磁吸在主窗口右侧，两个窗口的指针事件、滚动、输入完全独立互不阻塞。

**需要先调研确认的技术问题**（HITL 原因）：
1. Electrobun 1.x 是否支持创建多个独立 BunWindow，每个窗口独立渲染 WebView？
2. 是否有窗口位置跟随 API（主窗口移动/resize 时 sidecar 自动跟随）？
3. 两窗口间通信机制：sidecar 如何接收主窗口的上下文状态更新（AI-002 的选中状态）？
4. 窗口 z-order 和焦点管理：sidecar 获得焦点时主窗口是否失焦？
5. macOS WKWebView 沙箱对多窗口 RPC 的限制？

**期望最终行为**（待调研后确认实现路径）：
- 主窗口右侧磁吸一个独立 AI 窗口，视觉上像拼接出的第二个窗口
- 主窗口 resize 或移动时，sidecar 自动跟随
- 两窗口可独立接收键盘/鼠标事件
- sidecar 可被用户手动拖离，变为浮动独立窗口
- 关闭/重新打开时恢复上次放置位置（attached / detached / closed）

**如调研发现当前 Electrobun 版本不支持**，则降级为：在主窗口 WebView 内以 `position: fixed` 非模态侧边栏实现（已由 AI-001 完成），并在此 issue 记录结论和后续升级路径。

## Acceptance criteria

- [x] 完成 Electrobun 多窗口 API 调研，在此 issue 补充调研结论（Comments 区域）
- [x] 调研结论明确：可行 / 降级方案 / 需要 Electrobun 版本升级
- [x] 若可行：sidecar 窗口可打开，磁吸在主窗口右侧，主窗口表格操作不受影响
- [x] 若可行：主窗口 resize 时 sidecar 位置同步更新
- [ ] 若可行：sidecar 接收 AI-002 上下文状态更新（跨窗口 RPC 或共享 main process state）
- [ ] 若降级：在此 issue 记录降级理由和未来升级条件

## Blocked by

- `.scratch/agentic-ai-product/issues/01-global-ai-drawer-skeleton.md`

## Comments

### 2026-05-07 调研结论

结论：当前仓库安装的 `electrobun@1.16.0` 可行，不需要版本升级。

- 多窗口：`electrobun/bun` 导出 `BrowserWindow`，构造函数每次创建独立 native window，并自动挂载一个独立 `BrowserView`。
- 位置跟随：`BrowserWindow` 暴露 `getFrame()`、`setFrame()`、`setPosition()`、`setSize()`；窗口事件包含 `move` 和 `resize`，可在主窗口变化时重新计算 sidecar frame。
- 跨窗口通信：RPC 绑定在每个 `BrowserView` 上；sidecar 若要完整接收 AI-002 上下文，应创建自己的 RPC 或由 main process 保存最新 `AiContextSnapshot` 后主动推送到 sidecar view。
- 焦点/z-order：`BrowserWindow` 暴露 `focus()`、`show()`、`setAlwaysOnTop()` 以及 `focus/blur` 事件。当前实现打开 sidecar 后会 focus sidecar，因此主窗口可能失焦，但两个窗口事件流独立。
- macOS WKWebView：本地源码未显示多窗口 RPC 的特殊沙箱限制；`sandbox: true` 会禁用 RPC，本实现未启用 sandbox。

### 2026-05-07 产品决策更新

试用 native sidecar 后判断用户体验不如 Chrome/Gemini 这类单窗口右侧 AI 侧栏：独立窗口涉及可见区回推、关闭重开、焦点切换、跨窗口 RPC 和上下文同步，复杂度高且桌面体验割裂。

当前实现已改为单 WebView 内 docked AI panel：

- `GlobalAiLauncher` 继续作为右下角召唤入口。
- 打开后 AI 面板进入 `.app-body` 的右侧 flex 布局，占用固定宽度并压缩主内容区域，类似 Chrome 右侧 AI panel。
- 不再创建第二个 `BrowserWindow`，也不再需要 `openAiSidecar` RPC。
- 保留移动端 fixed overlay 降级，避免窄屏布局被挤压到不可用。

因此 AI-009 的 native sidecar 方向作为调研结论保留，但不继续作为当前产品实现路径。
