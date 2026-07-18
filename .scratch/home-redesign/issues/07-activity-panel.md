Status: done

## What to build

实现右侧常驻动态面板 `ActivityPanel.svelte`，提供「动态」/「数据概览」/「任务」三 tab 视图。

**Tab 控件**：segment control 样式（active item 背景色填充，三格等宽），非下划线样式。

**动态 tab**：活动流列表，每条记录显示头像 + 操作描述 + 相对时间（如"张三 添加了 12 条记录 · 2小时前"、"AI 助手 生成了 SurrealQL 查询 · 昨天"）。首期以 mock 数据占位（5-8 条）；数据层接口（读 `workspace_event` 表）预留但不要求接真实数据，`workspace_event` schema 属后续 issue。

**数据概览 tab**：`SELECT count() FROM workbook GROUP ALL` 查询本 workspace 工作簿总数；迷你 bar chart（纯 SVG 手绘，7 天横轴，模拟本周新增记录数趋势）。计数数字真实查询，趋势图首期 mock。

**任务 tab**：stub 占位，显示"虚拟办公室功能即将上线"空 state，不实现任何逻辑。

面板宽度 280px，固定高度 `100vh`，独立滚动。

## Acceptance criteria

- [x] 三个 tab 可切换，segment control 样式正确
- [x] 动态 tab 渲染 mock 活动流，时间显示相对格式
- [x] 数据概览 tab 查询并展示真实工作簿计数
- [x] 数据概览 tab 有迷你 bar chart SVG（mock 数据可接受）
- [x] 任务 tab 显示空 state 占位文案
- [x] 面板不影响主内容区和 sidebar 的滚动
- [x] svelte-check 无类型错误

## Blocked by

- HR-01 三栏无 topbar 布局骨架
