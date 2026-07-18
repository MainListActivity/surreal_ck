Status: done

## What to build

将 `WorkspaceScreen` + `SideNav` + `HomeScreen` 重构为三栏无 topbar 布局骨架，作为后续所有首页 issues 的基础。

移除 `HomeScreen` 内部的 topbar（搜索框 + 通知按钮），将整体结构改为：左侧 sidebar（最终实现收口为 256px）+ 主内容区（flex-1）+ 右侧动态面板（280px，仅 home 页渲染）。

`SideNav` 内部结构重组为四段：
- `.sidebar-top`：预留搜索框插槽（内容由 HR-02 填充）
- `.sidebar-nav`（`flex:1; overflow-y:auto`）：导航项（首页/仪表盘/我的文档/模板库）+ 底部工具项（工作区设置/SQL 控制台/回收站）
- `.sidebar-footer`：预留 workspace 切换面板插槽（内容由 HR-03 填充）
- `.sidebar-userbar`：头像 + workspace 名称占位文本 + 通知铃铛占位按钮

`WorkspaceScreen` 新增 `<ActivityPanel />` 组件占位（仅 `page === "home"` 时渲染），内容由 HR-07 填充。

`HomeScreen` 保留 greeting 区域和工作簿列表区域（列表样式暂不升级，由 HR-04 处理），移除 topbar。

## Acceptance criteria

- [x] 页面整体为 `display:flex; height:100vh`，三列并排，无 topbar
- [x] `SideNav` 固定 256px 宽，内部四段结构完整，`.sidebar-userbar` 始终固定在底部可见
- [x] `ActivityPanel` 占位组件在 home 页可见（280px 宽），在其他页面（workbook 编辑器等）不渲染
- [x] `HomeScreen` 不再渲染任何 topbar 元素
- [x] 删除 topbar 相关 CSS，无视觉残留
- [x] svelte-check 无类型错误

## Blocked by

None — can start immediately（建议在 HR-08 完成后开始，以便直接使用新 icon）
