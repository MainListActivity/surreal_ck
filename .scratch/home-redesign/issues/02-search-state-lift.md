## What to build

将搜索状态从 `HomeScreen` 提升到 `WorkspaceScreen`，并在 `SideNav` 顶部承载搜索框 UI。

`SideNav` 顶部（`.sidebar-top`）新增搜索输入框，触发 `onsearchchange: (q: string) => void` 事件向上传递。`WorkspaceScreen` 持有 `query` 状态，接收 `SideNav` 的事件后下传给 `HomeScreen` 作为 prop。`HomeScreen` 的工作簿过滤逻辑（`filterWorkbooksByQuery`）改为消费外部传入的 `query` prop，自身不再持有搜索状态。

搜索框样式：圆角输入框，带放大镜图标前缀，placeholder "搜索工作簿..."，`width:100%`。

## Acceptance criteria

- [ ] `SideNav` 顶部有可用的搜索框，输入后工作簿列表实时过滤
- [ ] `HomeScreen` 的 `filterWorkbooksByQuery` 逻辑不变，只是 `query` 来源改为 prop
- [ ] `query` 状态在 `WorkspaceScreen` 层持有，切换页面后回到首页搜索词保留
- [ ] `HomeScreen` 自身不再持有 `query` state
- [ ] svelte-check 无类型错误

## Blocked by

- HR-01 三栏无 topbar 布局骨架
