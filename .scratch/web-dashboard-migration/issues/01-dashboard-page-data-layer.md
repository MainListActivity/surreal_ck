Status: done
Label: done

# D3-01 — dashboard page 数据层（直连 CRUD + 单测）

> 2026-06-12 自 PRD 路线图行细化立项（PRD 注明"开工时细化"）。D3-05 已 ready-for-agent，
> 被本 issue 阻塞——这是 D3 簇第一块 substrate。

## Parent

`.scratch/web-dashboard-migration/PRD.md`

## Agent Brief

**Category:** enhancement
**Summary:** `web/src/lib/dashboard-data.ts` 提供 `dashboard_page` 表的浏览器直连 CRUD：
列表、读取、创建、改名、保存 widgets、删除。widget 内嵌形态与 `DashboardBuilderSpec`
同口径（legacy 的 `dashboard_view` 独立表 + 后端缓存随 appApi 一并退役）。

**Current behavior:**
legacy `web/legacy/lib/dashboards.svelte.ts` 全部走后端 `appApi` dashboard 集群
（listDashboardPages / createDashboardPage / saveDashboardPageLayout / ...），新架构下这些
代理 endpoint 不存在。`dashboard_page` schema 已在
`shared/sql/workspace-template/006-tables-grid.surql` 落地（title / slug / widgets[] /
workbook 可选，(workbook, slug) 唯一索引），但前端没有任何直连数据层。

**Desired behavior:**
- web 数据层定义 `DashboardWidget`：`{ id, title, viewType, spec: DashboardBuilderSpec, grid, display? }`
  ——内嵌进 `dashboard_page.widgets[]`；`spec` / `viewType` 直接复用 shared 既有类型，与 D3-02
  编译器、D3-05 草稿卡同口径，不出现第二套 widget 描述。server 不接触该包装形态，故不进 shared。
- `listDashboardPages(conn, workbookId?)`：直连 SELECT（参数化），按 updated_at 倒序，映射成 summary DTO。
- `loadDashboardPage(conn, pageId)`：读单页含 widgets。
- `createDashboardPage(conn, { title, workbookId? })`：slug 由 title 派生（中文标题回退随机后缀），
  撞 (workbook, slug) 唯一索引时报可读错误。
- `renameDashboardPage(conn, pageId, title)`：只改 title，slug 保持稳定（路由/链接不漂移）。
- `saveDashboardPageWidgets(conn, pageId, widgets)`：整组覆盖（新增/删除/布局统一入口）。
- `deleteDashboardPage(conn, pageId)`。
- 写路径权限由表 PERMISSIONS 兜底（admin-only），错误经 `describeWriteError` 翻译成中文；
  **不在查询里写任何 auth 过滤**。
- record id 内存中是 string，SDK 边界用 `record-id.ts` helper 包装。

**Out of scope:**
- widget 聚合查询编译器（D3-02）。
- widget 组件搬迁（D3-03）、屏幕/builder（D3-04）、AI 草稿卡（D3-05）。
- `dashboard_view` / cache 表——不再存在，不迁移。

**Acceptance criteria:**
- [x] 上述函数在 `web/src/lib/dashboard-data.ts`，fake `SurrealConn` 单测覆盖每个行为（TDD）。
- [x] 列表/读取查询是参数化 SELECT，不含权限过滤。
- [x] 创建时 slug 派生 + 唯一冲突报中文错误；改名不动 slug。
- [x] `pnpm --filter @surreal-ck/web test` 与 `typecheck` 通过。

## Comments

**2026-06-12（完成）**：`web/src/lib/dashboard-data.ts` + 13 个单测（fake SurrealConn，TDD
逐行为推进）。要点：

- `DashboardWidget` 定义在 web 数据层（非 shared）——server 永远接触不到该包装形态，
  `spec`/`viewType` 直接复用 shared 的 `DashboardBuilderSpec` / `DashboardViewType`，
  与 D3-02 编译器、D3-05 草稿卡同口径。
- 列表语义：无 `workbookId` → `workbook IS NONE`（workspace 级页）；有 → `workbook = $wb`
  （RecordId 绑定）。三条 SELECT 已过 `surreal validate`。
- 改名**不**重派生 slug（与 legacy 后端行为相反）：slug 进路由后改名不应让链接漂移。
- 错误翻译：撞 `dashboard_page_slug_unique` → "同名仪表盘页已存在"；权限拒绝 →
  "仅工作区管理员可管理仪表盘页"；其余兜回 `describeWriteError`。
- D3-02（聚合编译器）现在可开工，substrate 就绪。
