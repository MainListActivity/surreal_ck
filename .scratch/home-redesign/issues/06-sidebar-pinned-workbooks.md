## What to build

在 `SideNav` 导航区新增固定工作簿列表，支持将工作簿固定到 sidebar 快速访问。

**数据层**：`pinnedWorkbooks` 状态存 `localStorage`（key: `surreal_ck.pinned_workbooks.<dbName>`，用 dbName 隔离不同 workspace）。`SideNav` 启动时读取并展示已固定列表。

**sidebar 固定区**：在导航项下方新增「已固定」分区标题 + 已固定工作簿列表（图标 + 名称，点击直接跳转对应工作簿）。分区右上角有「+」按钮，点击弹出工作簿选择器（简单列表，选中即固定）。

**固定操作入口**：HR-04 工作簿卡片的悬停「...」菜单中「固定到侧边栏」选项，调用同一个 `pinWorkbook(id)` 函数写入 localStorage。

首期只做固定，不做取消固定 UI（拖拽排序、右键取消留后续）。

## Acceptance criteria

- [ ] sidebar 已固定区正确读取 localStorage 并渲染固定列表
- [ ] 点击已固定工作簿可跳转编辑器
- [ ] 「+」按钮打开选择器，选中后工作簿出现在固定列表
- [ ] 工作簿卡片「...」菜单中「固定到侧边栏」选项可用
- [ ] 不同 workspace（dbName 不同）的固定列表互不干扰
- [ ] svelte-check 无类型错误

## Blocked by

- HR-01 三栏无 topbar 布局骨架
- HR-04 工作簿卡片升级（需要卡片「...」菜单）
