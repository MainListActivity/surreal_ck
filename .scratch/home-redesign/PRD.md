# PRD — 工作区首页重设计

Status: done

## Problem Statement

当前首页（`HomeScreen.svelte` + `SideNav.svelte`）的信息密度过低，空间利用率差：

- 工作簿列表是平铺行列表，无预览、无协作信息、无状态标签，扫描成本高
- 顶部有独立 topbar（搜索 + 通知），与左侧 SideNav 割裂，浪费垂直空间
- workspace 切换器（`WorkspaceSwitcher`）藏在 SideNav 上方一个独立控件里，入口不明显，与当前 workspace 上下文（greeting、AI 入口文案）没有视觉关联
- 没有活动动态面板，协作者的操作、AI 任务、表单提交等事件完全不可见
- AI 入口只是右下角浮球，不能传达"它能做什么"

法律/金融用户每日打开工作簿频次高、协作人多，需要一眼看清"现在最该处理什么"。

## Solution

将工作区首页重构为三栏无 topbar 布局：

- **左侧 sidebar**（最终实现为 256px）：顶部放 logo + 搜索框，中间放导航 + 固定工作簿，底部固定用户栏（头像 + workspace 名称 + 通知），workspace 切换 panel 从用户栏向上滑出
- **主内容区**（flex-1）：greeting（含 workspace 切换 trigger）+ 快捷操作卡片 + AI banner + 工作簿卡片网格（带缩略图预览、协作者头像、状态标签）
- **右侧动态面板**（280px）：动态 / 数据概览 / 任务三 tab，动态 tab 展示活动流 + 本周统计迷你图

workspace 切换提供两个触发点：主内容区 greeting 行的工作区名称、sidebar 底部用户栏的工作区名称——均展开同一个内嵌滑出 panel，显示所有可访问工作区 + 新建入口。

## User Stories

1. 作为工作区成员，我想在首页不看 topbar 就能直接看到工作簿列表，以便减少视觉跳转
2. 作为工作区成员，我想在 sidebar 的搜索框中搜索工作簿、字段、关系，以便快速定位内容
3. 作为工作区成员，我想在 sidebar 底部看到通知铃铛，以便随时感知未读消息
4. 作为工作区成员，我想点击 sidebar 底部用户栏的 workspace 名称弹出切换 panel，以便用最短路径切换到其他工作区
5. 作为工作区成员，我想在主内容区 greeting 行也能点击 workspace 名称展开切换 panel，以便在首页上下文里直接切换
6. 作为工作区成员，我想在切换 panel 中看到每个工作区的名称、我的角色（管理员/成员），以便做出正确的切换决策
7. 作为工作区成员，我想切换 panel 带"当前工作区"勾选标记，以便知道自己现在在哪里
8. 作为工作区管理员，我想在切换 panel 末尾看到"新建工作区"入口，以便快速发起创建流程
9. 作为工作区成员，我想看到工作簿卡片带网格预览缩略图，以便在视觉上快速区分不同工作簿
10. 作为工作区成员，我想在工作簿卡片上看到协作者头像，以便了解谁在同时使用这个文档
11. 作为工作区成员，我想在工作簿卡片上看到状态标签（如"进行中""待审核"），以便快速判断优先级
12. 作为工作区成员，我想在工作簿卡片上看到图关系工作簿的节点预览图，以便与表格类工作簿视觉区分
13. 作为工作区成员，我想在快捷操作区看到"空白工作簿""从模板创建""导入文件"三张卡片，以便一次点击发起对应动作
14. 作为工作区成员，我想在首页顶部看到 AI banner，告知 AI 能生成 SurrealQL 并直接操作数据，以便知道 AI 的能力边界
15. 作为工作区成员，我想点击 AI banner 的"开始对话"按钮，以便直接打开 AI 对话抽屉
16. 作为工作区成员，我想在右侧动态面板看到协作者的近期操作（谁添加了几条记录、谁新增了字段），以便感知团队进展
17. 作为工作区成员，我想在右侧动态面板看到 AI 助手的近期任务结果（生成了什么查询），以便复盘 AI 行为
18. 作为工作区成员，我想在右侧动态面板的"数据概览" tab 看到本周新增记录数 + 迷你趋势图，以便快速了解数据增长情况
19. 作为工作区成员，我想在 sidebar 看到固定工作簿列表，以便一键跳转高频使用的工作簿
20. 作为工作区成员，我想在 sidebar 固定区右上角看到"+"按钮，以便将工作簿固定到侧边栏
21. 作为工作区成员，我想在首页工作簿列表切换"全部""我创建的""与我共享"三个 tab，以便快速筛选范围
22. 作为工作区成员，我想在首页工作簿列表切换网格/列表两种视图，以便按自己习惯浏览
23. 作为工作区成员，我想在首页 greeting 看到当前时段问候语 + workspace 名称，以便确认自己在正确的 workspace
24. 作为工作区管理员，我想在 greeting 下方看到 SurrealDB 连接状态（已连接/断开），以便及时发现连接问题
25. 作为工作区成员，我想 sidebar 底部用户栏始终可见，以便随时查看自己的身份并访问通知

## Implementation Decisions

### 布局层（`WorkspaceScreen.svelte` + `SideNav.svelte`）

- 移除 `HomeScreen.svelte` 内部的 topbar（搜索框 + 通知按钮），改由 `SideNav` 顶部承载
- `WorkspaceScreen` 的 `.workspace-shell` 保持 `display:flex; height:100vh`，新增右侧动态面板 slot：`<ActivityPanel />`（仅在 `page === "home"` 时渲染）
- `SideNav` 结构调整为：
  1. `.sidebar-top`：logo + 搜索框（复用 `HomeScreen` 的搜索逻辑，通过 prop/event 上传 query 给 `HomeScreen`）
  2. `.sidebar-nav`（`flex:1; overflow-y:auto`）：导航项 + 固定工作簿区
  3. `.sidebar-footer`：工作区设置 + SQL 控制台
  4. `.sidebar-userbar`：头像 + workspace 名称（切换 trigger） + 通知按钮
  5. `.ws-panel`（`max-height:0` → `.open` → `max-height:260px`，CSS transition）：workspace 列表 + 新建入口，位于 `.sidebar-footer` 与 `.sidebar-userbar` 之间

### WorkspaceSwitcher 改造

现有 `WorkspaceSwitcher.svelte` 使用 shadcn-svelte `DropdownMenu`，以独立 dropdown 形式存在于 SideNav 上方 `.ws-slot`。

新设计要求：
- 两个触发点（sidebar 用户栏名称 + 主内容区 greeting 行名称）控制同一个 inline panel
- Panel 内嵌在 sidebar 结构中（`position:static`），避免 `position:fixed` 在不同视口下的定位问题
- 保留现有 `loadWorkspaces` / `switchWorkspace` / `createCreateEntryController` 逻辑，只重写展现层

选择方案：将 `WorkspaceSwitcher` 拆为两层：
- `switch-workspace-panel.ts`（纯逻辑层）：open/close 状态、choose(slug)、startCreate，不依赖 DOM
- `WorkspaceSwitcherPanel.svelte`（视图层）：inline panel，绑上述逻辑，接受 `open` prop 由 SideNav 控制
- `SideNav` 持有 `wsPanelOpen: boolean` 状态，sidebar 用户栏触发它；同时通过 slot/prop 传递 workspace name 给主内容区 greeting 用于第二个 trigger

### HomeScreen 重构

- 移除 `<header class="topbar">` 块（搜索改到 SideNav，通知改到 sidebar userbar）
- 接收来自 SideNav 的 `query: string` prop（SideNav 持有搜索状态，通过 `onquerychange` event 向上传，WorkspaceScreen 中转给 HomeScreen）
- 新增 `<QuickActionCards />`（内联）：三张快捷卡片，样式升级为带图标色块
- 新增 `<AiBanner />`（内联或独立组件）：展示 AI 能力说明 + "开始对话"按钮，点击触发 `onopenaichat` prop
- 工作簿卡片升级为带预览区（`workbook-card-preview`）：
  - 有 `templateKey` 的工作簿按类型展示对应视觉（表格网格 / 图谱节点 / 空白）
  - 展示 `updatedAt` 格式化时间
  - 协作者头像：首阶段以静态 mock 占位，后续接 LIVE 在线用户（超出 D4 范围）
  - 状态标签：首阶段以 `templateKey` 作为标签来源，后续接工作簿状态字段

### ActivityPanel（新组件）

- `web/src/components/ActivityPanel.svelte`
- Tab 切换：动态 / 数据概览 / 任务（segment control 样式，`background` 切换而非下划线）
- "动态" tab：读 `workspace_event` 表（若无则以 mock 数据占位，事件表 schema 属后续 issue）
- "数据概览" tab：`SELECT count() FROM workbook GROUP ALL` + 迷你 bar chart（SVG 手绘）
- 首期实现可以用 mock 数据，数据层接口预留但不强制接真实 LIVE

### 搜索状态提升

- `query` 状态从 `HomeScreen` 提升到 `WorkspaceScreen`（或 `SideNav` 通过 event 上传）
- `WorkspaceScreen` 把 `query` 下传给 `HomeScreen`
- SideNav 搜索框触发 `onsearchchange: (q: string) => void`

### 固定工作簿

- `pinnedWorkbooks` 状态存 localStorage（key: `surreal_ck.pinned_workbooks.<dbName>`）
- `SideNav` 读写该状态；固定/取消固定通过工作簿卡片右键菜单或 sidebar "+" 按钮触发（首期可只做固定，不做取消固定 UI）

## Testing Decisions

**什么是好的测试：** 只测外部行为（组件 props/events 接口、纯逻辑函数的输入输出），不测 DOM 结构或 CSS class 名称。

**测试模块：**

1. `switch-workspace-panel.ts`（如果拆出纯逻辑层）
   - `choose(slug)` 调用 `switchWorkspace` 并在成功后关闭 panel、更新 current
   - `choose(slug)` 在 slug === current 时不触发网络请求直接关闭
   - 先例：`web/src/lib/switch-workspace.test.ts`

2. `workbooks.ts` 现有测试覆盖 `filterWorkbooksByQuery`，新卡片数据无需额外单元测试

3. `ActivityPanel` 的数据层（若有 `workspace-activity.ts`）
   - 读取 `workspace_event` 返回正确的事件列表结构
   - 先例：`web/src/lib/workbook-data.test.ts`

**不测：**
- 卡片预览的 SVG 渲染细节
- CSS 动画/过渡时长
- `ActivityPanel` 的 mock 数据阶段（mock 不测）

## Out of Scope

- 协作者实时在线头像（需要 LIVE 在线用户方案，属 D4+ 范围）
- 工作簿状态字段（`status`）的 schema 定义和迁移脚本
- `workspace_event` 表 schema 及写入逻辑（动态 tab 首期以 mock 数据占位）
- 固定工作簿的取消固定 UI（首期只做固定）
- "与我共享" tab 的真实数据（需成员权限模型，首期以空 state 占位）
- 右侧面板"任务" tab 的实现（占位 tab，内容属 virtual-office 簇）
- 通知中心的具体内容（铃铛入口先 stub）
- 导入文件功能（仍为 "敬请期待" 状态）
- 移动端响应式（≤768px 折叠 sidebar）

## Further Notes

- 设计稿原型已存入项目：`.scratch/home-redesign/prototype.html`（原始文件同步位于 `~/.gstack/projects/MainListActivity-surreal_ck/designs/home-redesign-20260613/finalized.html`），可通过 `python3 -m http.server` 在 `.scratch/home-redesign/` 目录下本地预览
- workspace 切换逻辑（`switchWorkspace` / `loadWorkspaces`）完全保留现有实现，只重写触发 UI
- `WorkspaceSwitcher` 现有 shadcn-svelte `DropdownMenu` 包裹层在新方案中可移除，改为 CSS `max-height` 内嵌 panel——避免 fixed 定位问题，也减少对 shadcn portal 的依赖
- 右侧动态面板与 `AiDrawer` 不冲突：`AiDrawer` 是全屏覆盖层，动态面板是常驻侧边栏
- SurrealDB 连接状态（`getConnectionState()`）已在 `WorkspaceSwitcher` 中使用，可直接复用到 greeting 行的连接状态 dot
