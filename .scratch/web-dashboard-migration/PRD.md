# PRD — Web Dashboard 直连迁移（簇 D3，独立于 D2-07 表格编辑器）

> 状态：planned（未开工）。从 D2-07 组件迁移中拆出——dashboard 是另一整套
> 数据路径（聚合查询），不阻塞表格编辑器跑通。

## 背景

legacy `web/legacy/lib/dashboards.svelte.ts` 建在后端 `appApi` 的 dashboard 集群上：
`listDashboardPages / createDashboardPage / createDashboardView / previewDashboardView /
updateDashboardView / refreshDashboardPage / saveDashboardPageLayout` 等——全部是后端
算好的聚合结果。新架构要求浏览器直连 SurrealDB，用真实 SurrealQL 聚合
（GROUP BY / COUNT / SUM）产出 widget 数据，**后端不参与**。

`dashboard_page` 表 schema 已在 `shared/sql/workspace-template/006-tables-grid.surql`
定义（title / slug / widgets[] / workbook 可选）。

## 范围

- dashboard 数据层：page CRUD（直连 `dashboard_page` 表读写）+ widget 聚合查询编译器
  （widget 配置 → SurrealQL GROUP BY/COUNT/SUM/时间序列）。
- 6 个 widget 组件搬迁：`features/dashboard/widgets/{Kpi,CategoryBar,Pie,TimeSeries,Area,Table}Widget.svelte`。
- `WorkbookDashboardScreen.svelte` / `DashboardViewBuilder.svelte` / `DashboardWidgetFrame.svelte`。
- EditorScreen 里的 dashboard stub（D2-07h 留的）替换为真实屏幕。

## 依赖

- D2-07 表格编辑器全簇跑通（07h 收口）。
- surrealql skill / surrealdb-vector skill（聚合 + 可能的相似度）。

## 不做

- 不在后端加任何 dashboard 聚合代理 endpoint——聚合是 SurrealQL，浏览器直连执行。

## Issue 路线图（草拟，开工时细化）

| # | 名称 | 主体 |
|---|---|---|
| D3-01 | dashboard page 数据层 | `dashboard_page` 直连 CRUD + 单测 |
| D3-02 | widget 聚合查询编译器 | widget 配置 → 参数化 SurrealQL（GROUP BY/COUNT/SUM/时间桶）+ 单测 |
| D3-03 | widget 组件搬迁 | 6 个 widget + WidgetFrame |
| D3-04 | Dashboard 屏幕 + builder | WorkbookDashboardScreen + ViewBuilder + 接 EditorScreen stub |
