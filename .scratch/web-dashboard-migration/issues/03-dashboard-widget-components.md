Status: done
Label: done

# D3-03 — widget 组件搬迁（6 widget + WidgetFrame + 注册表）

> 2026-06-12 自 PRD 路线图行细化立项。D3-01/D3-02 已提供数据层与聚合查询
> substrate；本 issue 提供 D3-04 屏幕与 D3-05 草稿预览共用的展示层，
> 完成后 D3-05 的 D3 侧阻塞全部解除。

## Parent

`.scratch/web-dashboard-migration/PRD.md`

## Agent Brief

**Category:** enhancement
**Summary:** 把 legacy `web/legacy/features/dashboard/` 的 6 个 widget 组件
（Kpi / CategoryBar / Pie / TimeSeries / Area / Table）、`DashboardWidgetFrame` 与
widget 注册表迁入 `web/src/features/dashboard/`，输入合约从 legacy
`DashboardViewDTO` + `DashboardCacheDTO` 改绑 shared 的
`DashboardNormalizedResult`（D3-02 直连执行的归一化结果）。

**Current behavior:**
legacy widget 的 props 是 `{ view: DashboardViewDTO; cache?: DashboardCacheDTO }`——
依赖后端 `dashboard_view` 独立表 + 缓存集群，这套 DTO 随 appApi 一并退役。
新架构下 `runDashboardWidgetQuery` 已能产出
`single_value` / `category_breakdown` / `time_series` / `table_rows` 四种归一化结果，
但没有任何组件消费它。

**Desired behavior:**

- 6 个 widget 迁入并改为纯展示组件：props 收 `DashboardNormalizedResult`
  （或对应窄化分支）+ 标题 / displaySpec 等展示参数；组件内部**不发查询、不持连接**。
- `DashboardWidgetFrame`（标题 / 副标题 / 编辑 / 移除按钮 + children snippet）原样迁入。
- widget 注册表迁入：按 `DashboardViewType`（kpi / table / bar / line / pie / area）
  映射组件，供 D3-04 屏幕与 D3-05 草稿卡共用查找——零 AI 特化分支。
- 结果为空 / 形态与 viewType 不匹配时显示占位（"—" 或空态），不抛错。
- 样式沿用 legacy（CSS 变量 token），不做视觉重设计。

**Key interfaces:**

- `DashboardNormalizedResult`（shared rpc 类型）——widget 输入合约，与 D3-02
  `runDashboardWidgetQuery` 输出同口径。
- `DashboardViewType` ——注册表 key，与 D3-01 `DashboardWidget.viewType` 同口径。

**Out of scope:**

- Dashboard 屏幕 / builder / EditorScreen stub 替换（D3-04）。
- AI 草稿卡接线（D3-05）。
- 组件内数据获取或刷新逻辑——查询执行归 D3-02 调用方。

## Acceptance criteria

- [ ] 6 个 widget + `DashboardWidgetFrame` + 注册表迁入 `web/src/features/dashboard/`，
      不再 import 任何 `web/legacy/**` 或已退役 DTO（`DashboardCacheDTO` 等）。
- [ ] 每种 `DashboardViewType` 在注册表可查得组件；查不到时调用方可拿到 undefined。
- [ ] widget 用 fake `DashboardNormalizedResult` 渲染正确（KPI 值 / 分类条 / 饼图占比 /
      时间序列 / 表格行），结果缺失或形态不匹配时显示占位不抛错——纯逻辑部分有单测。
- [ ] `pnpm --filter @surreal-ck/web test` 与 `typecheck` 通过。

## Blocked by

None - can start immediately（D3-01 / D3-02 已 done）。
