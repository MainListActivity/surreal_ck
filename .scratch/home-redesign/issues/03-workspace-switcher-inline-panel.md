## What to build

将 workspace 切换功能从 shadcn `DropdownMenu` 改为内嵌在 sidebar 中的滑出面板，同时支持两个触发点。

**纯逻辑层** `switch-workspace-panel.ts`（新建）：管理 `open/close` 状态、`choose(slug)` 调用 `switchWorkspace` 后关闭面板并更新当前 workspace、`startCreate()` 打开新建 workspace 对话框。`choose(slug)` 在 slug 等于当前 workspace 时不触发网络请求直接关闭。

**视图层** `WorkspaceSwitcherPanel.svelte`（替换现有 `WorkspaceSwitcher.svelte`）：inline panel，位于 `.sidebar-footer` 与 `.sidebar-userbar` 之间，`max-height:0` → `.open` → `max-height:260px` CSS transition 滑出。列表展示所有可访问 workspace，当前 workspace 带勾选标记，每行显示 workspace 名称和角色（管理员/成员）。末尾有「新建工作区」入口（调用现有 `createCreateEntryController`）。

**两个触发点**：
1. `SideNav` 的 `.sidebar-userbar` 中 workspace 名称点击 → 切换 `wsPanelOpen` 状态
2. `HomeScreen` 的 greeting 行 workspace 名称点击 → 通过 prop/event 触发同一个 `wsPanelOpen`（`WorkspaceScreen` 中转）

保留现有 `loadWorkspaces` / `switchWorkspace` / `createCreateEntryController` 逻辑不变，只重写展现层。移除对 shadcn `DropdownMenu` 的依赖。

## Acceptance criteria

- [x] 点击 sidebar 用户栏的 workspace 名称，panel 从底部向上滑出，再次点击收起
- [x] 点击首页 greeting 行的 workspace 名称，触发同一个 panel 滑出
- [x] panel 内列出所有可访问 workspace，当前 workspace 有勾选标记
- [x] 每行显示 workspace 名称和角色标签
- [x] 点击非当前 workspace 触发切换，切换完成后 panel 自动关闭
- [x] 点击当前 workspace 直接关闭 panel，不触发网络请求
- [x] 「新建工作区」入口调用现有创建流程
- [x] `switch-workspace-panel.ts` 有单元测试覆盖 `choose()` 正常路径和幂等路径
- [x] svelte-check 无类型错误

## Blocked by

- HR-01 三栏无 topbar 布局骨架
