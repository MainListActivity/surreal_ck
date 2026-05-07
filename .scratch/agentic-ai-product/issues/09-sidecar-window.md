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

- [ ] 完成 Electrobun 多窗口 API 调研，在此 issue 补充调研结论（Comments 区域）
- [ ] 调研结论明确：可行 / 降级方案 / 需要 Electrobun 版本升级
- [ ] 若可行：sidecar 窗口可打开，磁吸在主窗口右侧，主窗口表格操作不受影响
- [ ] 若可行：主窗口 resize 时 sidecar 位置同步更新
- [ ] 若可行：sidecar 接收 AI-002 上下文状态更新（跨窗口 RPC 或共享 main process state）
- [ ] 若降级：在此 issue 记录降级理由和未来升级条件

## Blocked by

- `.scratch/agentic-ai-product/issues/01-global-ai-drawer-skeleton.md`
