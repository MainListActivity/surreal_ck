Status: ready-for-agent
Label: ready-for-agent

# D3-04 — Dashboard 屏幕 + builder（接 EditorScreen stub）

> 2026-06-12 自 PRD 路线图行细化立项。D3-01（page CRUD）、D3-02（聚合查询）、
> D3-03（widget 组件）三块 substrate 齐备后，本 issue 把手工 dashboard 全链路
> 收口到屏幕：列表 → 建页 → builder 配 widget → 直连预览 → 保存 → 渲染。

## Parent

`.scratch/web-dashboard-migration/PRD.md`

## Agent Brief

**Category:** enhancement
**Summary:** 迁入 `WorkbookDashboardScreen` 与 `DashboardViewBuilder`，全部数据路径
改直连：page CRUD 走 D3-01 `dashboard-data`，widget 预览 / 刷新走 D3-02
`runDashboardWidgetQuery`，widget 渲染走 D3-03 注册表；替换 EditorScreen 里
D2-07h 留下的 dashboard stub（"看板即将上线"）。

**Current behavior:**
legacy 屏幕与 builder 全建在后端 appApi dashboard 集群上
（listDashboardPages / createDashboardView / previewDashboardView /
refreshDashboardPage / saveDashboardPageLayout / dashboard_view 独立表 + 缓存）——
这些 endpoint 在新架构不存在。`web/src/screens/EditorScreen.svelte` 的
`pageKind === "dashboard"` 分支只渲染占位 div（`editorUi.dashboardPageId` 已就位）。

**Desired behavior:**

- EditorScreen dashboard 分支渲染真实屏幕：按 `dashboardPageId` 加载
  `dashboard_page`，逐 widget 用当前会话直连执行聚合并经注册表渲染；
  页面切换、空态（无 page / page 无 widget）有明确 UI。
- builder（新建 / 编辑 widget）：选数据表（来源 editorStore sheets）、统计指标
  （count / sum / count_distinct）、分组维度、筛选、时间桶；配置变化时直连执行
  **只读**预览（`runDashboardWidgetQuery`），非法配置（`validateDashboardWidgetSpec`
  拒绝）显示中文错误且不允许保存。
- 保存 = 更新 `dashboard_page.widgets[]`（`saveDashboardPageWidgets`），widget 形态
  与 D3-01 `DashboardWidget` 同口径——AI（D3-05）与手工 builder 产出的 widget
  在编辑 / 移除 / 刷新行为上完全一致。
- widget 移除、page 新建 / 改名 / 删除全部直连；"刷新" = 前端重跑聚合查询，
  **无后端缓存、无代理 endpoint**。
- 写入被 `dashboard_page` PERMISSIONS 拒绝时显示中文错误提示，
  不在前端预判 `is_admin`。

**Key interfaces:**

- D3-01 `dashboard-data`：list / load / create / rename / saveWidgets / delete。
- D3-02 `dashboard-query`：compile + validate + run，builder 预览与屏幕渲染共用。
- D3-03 widget 注册表 + `DashboardWidgetFrame`：渲染与编辑 / 移除入口。
- `editorUi.pageKind` / `editorUi.dashboardPageId`（D2-07h 已就位）——路由态来源。

**Out of scope:**

- AI 草稿卡保存与 resume（D3-05）。
- 后端 dashboard 聚合 / 缓存 / 刷新代理 endpoint——PRD 明确不做。
- 自由拖拽布局引擎——布局能力对齐 legacy 即可，不扩展。
- raw SQL widget 通道（与 D3-05 一并的 V1 排除项）。

## Acceptance criteria

- [ ] EditorScreen dashboard 分支不再是占位 div：能从列表进入 page，widget 以真实
      直连聚合数据渲染。
- [ ] builder 全流程可走通：新建 widget → 配置 → 直连只读预览 → 保存 →
      `dashboard_page.widgets[]` 出现对应记录（直连 SELECT 断言）→ 屏幕渲染。
- [ ] 编辑既有 widget 与移除 widget 落库生效；page 新建 / 改名 / 删除可用。
- [ ] 非法 builder 配置被拒且显示中文错误，不产生写入。
- [ ] 屏幕 / builder 代码不 import `web/legacy/**`、不调用任何 appApi dashboard
      endpoint；预览路径无写语句。
- [ ] 纯逻辑层（builder 草稿 → BuilderSpec、widget → 保存 payload 等）有 fake 连接
      单测；`pnpm --filter @surreal-ck/web test` 与 `typecheck` 通过。

## Blocked by

- `.scratch/web-dashboard-migration/issues/03-dashboard-widget-components.md`（D3-03）
