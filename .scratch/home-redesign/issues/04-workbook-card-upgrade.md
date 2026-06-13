## What to build

将首页工作簿列表从平铺行升级为带预览缩略图的卡片网格，同时新增筛选 tab 和视图切换。

**卡片预览区**（`workbook-card-preview`）：按 `templateKey` 区分三种视觉：
- 表格类：渲染 3×4 网格模拟单元格（浅色边框线）
- 图谱类：渲染 3 个节点 + 连线的 SVG
- 空白/未知：渲染纯色占位区块

卡片信息区：工作簿名称、`updatedAt` 格式化（"3 小时前" / "昨天"）、协作者头像（首阶段静态 mock 1-3 个头像气泡，超出显示 +N）、状态标签（来源：`templateKey` 映射为"进行中"/"待审核"等，后续接真实 status 字段）。

**卡片操作**：悬停显示右上角「...」更多菜单（固定到 sidebar、删除）。固定操作由 HR-06 实现，此处只预留 `onpin` prop。

**筛选 tab**（网格顶部）：「全部」/「我创建的」/「与我共享」三 tab。「与我共享」首期渲染空 state 占位（需权限模型，Out of Scope）。

**视图切换**：网格/列表两种模式，状态存 `localStorage`（key: `surreal_ck.workbook_view_mode`）。

## Acceptance criteria

- [ ] 工作簿以卡片网格排列，每张卡片有预览区 + 信息区
- [ ] 三种 `templateKey` 对应三种预览样式，视觉可区分
- [ ] `updatedAt` 以相对时间展示
- [ ] 协作者头像区域渲染（mock 数据，非真实在线状态）
- [ ] 「全部」/「我创建的」两个 tab 可正常过滤；「与我共享」tab 显示空 state
- [ ] 网格/列表切换可用，选择记忆跨页面刷新保留
- [ ] svelte-check 无类型错误

## Blocked by

- HR-01 三栏无 topbar 布局骨架
