Status: needs-triage
Label: needs-triage

# WP-D2-07i — Workspace 首页 + 页面入口保底

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

把 legacy 中用户可到达的首页 / 我的文档 / 侧栏导航迁到 `web/src/`，让 `/w/:slug` 成为进入工作区后的主入口：

- `/w/:slug` 渲染 workspace 首页，显示 workspace switcher、搜索、quick actions、workbook 列表。
- 点击 workbook 进入 `/w/:slug/wb/:workbookId`；指定 sheet 仍由 07h 的 editor route 处理。
- “空白文档 / 从模板创建 / 导入文件 / 通知 / 我的文档 / 仪表盘 / 工作区设置 / 个人设置 / 回收站”等 legacy 可见按钮不能静默消失：已迁功能直接可用，暂未迁功能必须显示明确占位或禁用态。
- `web/legacy/` 删除前，完成一次页面与按钮 inventory，对每个 legacy screen 给出新 web 路由、迁移策略或后续 issue 归属。

这个 issue 是 D2-09 删除 `web/legacy/` 的前置安全阀：目标不是一次性完成所有业务页，而是保证导航信息架构和用户可见入口不丢。

## Page inventory to preserve

| Legacy page / entry | D2-07i target | Notes |
|---|---|---|
| `HomeScreen` | `/w/:slug` | 真实 workbook 列表、搜索、最近/我的/共享 tab、list/grid 切换、空白文档入口。 |
| `MyDocsScreen` | `/w/:slug/docs` 或首页内 tab | 至少保留“我的文档”入口和文档列表；目录树/拖拽可先降级为只读或后续 issue。 |
| `SideNav` | workspace shell | 品牌、workspace 入口、新建文档、首页、仪表盘、我的文档、工作区设置、回收站、个人设置、退出登录入口不丢。 |
| `TemplatesScreen` | `/w/:slug/templates` placeholder or migrated page | 模板列表依赖旧 `appApi`，若不在本 issue 完成，则按钮进入明确“模板创建待迁移”占位。 |
| `DashboardScreen` | `/w/:slug/dashboard` placeholder | Dashboard 已拆到 D3；入口保留，页面显示“仪表盘即将上线”。 |
| `AdminScreen` | `/w/:slug/admin` placeholder or member page | 工作区设置入口保留；成员管理真实能力可后续接 Workspace Scope Module。 |
| `SettingsScreen` | `/w/:slug/settings` placeholder | 个人/AI/embedding 设置依赖旧 `appApi`，入口保留，不再调用 legacy RPC。 |
| `PublicFormScreen` | `/form` / `/form-success` placeholder or migrated static form | 若 D2 不迁真实表单发布，至少保留可访问页面和返回首页按钮。 |
| `ResearchWindowScreen` | later resource-search issue | 资源检索窗口不是当前主流程；入口若出现，必须明确标记待迁移。 |
| `StateScreen` | reusable empty/error states | 空、离线、无权限状态保留为通用页面/组件。 |
| `AdminConsoleScreen` | not in visible nav | 不作为普通用户入口；如保留快捷入口，必须是显式 dev/admin-only placeholder。 |

## Acceptance criteria

- [ ] 登录后访问 `/w/:slug` 不再只看到 session summary，而是 workspace 首页 shell。
- [ ] 首页能通过 `workbooksStore` 加载当前 workspace workbook 列表，搜索能过滤名称 / template key。
- [ ] 点击 workbook 跳转到 `/w/:slug/wb/:workbookId`，由 07h EditorScreen 加载编辑器。
- [ ] “空白文档”按钮按权限启用；成功创建后进入新 workbook；无权限时有禁用态或明确提示。
- [ ] “从模板创建 / 导入文件 / 通知 / 仪表盘 / 工作区设置 / 个人设置 / 回收站”等 legacy 可见入口均存在；未迁功能必须进入占位页或弹出明确说明，不允许按钮消失或无反馈。
- [ ] 页面 inventory 表里的每个 legacy screen 都有新路由、占位或后续 issue 归属；D2-09 删除 `web/legacy/` 前可据此核对。
- [ ] 新路由不引入后端 workbook / table CRUD 代理；业务数据仍通过浏览器直连 SurrealDB 或已有 Workspace Scope Module。
- [ ] `pnpm --filter @surreal-ck/web test`、`typecheck`、`build` 均通过；浏览器 console 无 legacy RPC / desktop shell import 错误。

## Blocked by

- `.scratch/web-frontend-migration/issues/05a-workspace-switcher-create-entry.md`
- `.scratch/web-frontend-migration/issues/07h-editor-screen-routes.md`

## Notes

- D3 dashboard 迁移不并入本 issue；本 issue 只保留 dashboard 入口和占位。
- AI 抽屉仍按 D2-08 迁；本 issue 不阻塞其内部 chat/stream 接线，但应预留 shell 挂载位置。
- 缺少后端能力的旧页面不要临时恢复 legacy `appApi` / desktop RPC；用占位和后续 issue 归属替代。

## Resolution（D2-07i 完成情况，D2-09 删 `web/legacy/` 前据此核对）

新增/接线：

- `web/src/lib/route.ts`：新增 `workspace` route kind（`page = home/docs/templates/dashboard/admin/settings/trash`）+ `form` / `form-success`；新增 `workspacePath()`。
- `web/src/lib/switch-workspace.ts`：新增 `bootstrapWorkspace(slug?)`——按 URL slug / token 当前 db / 首个 workspace 建立 SurrealDB 直连（`switchWorkspace` 在「已在目标」时短路不连库，进入页面必须走它）。svelte 单例同步导出。
- `web/src/components/SideNav.svelte`：新架构侧栏（品牌 / WorkspaceSwitcher / 新建文档 / 首页 / 仪表盘 / 我的文档 / 模板库 / 工作区设置 / 回收站 / 个人设置 / 退出）。**folder 树 + 拖拽未迁**（新模型无 folder 表，跨 workspace 靠 db 边界），「我的文档」退化为导航入口。
- `web/src/screens/WorkspaceScreen.svelte`：首页 shell，按 `page` 切 HomeScreen / 占位页，挂 CreateWorkspaceDialog。
- `web/src/screens/HomeScreen.svelte`：真实 workbook 列表（直连 `workbooksStore`）+ 搜索（name/templateKey）+ 空白文档（按 `canWriteSharedStructure` 启停）+ 模板入口。
- `web/src/screens/PlaceholderScreen.svelte`：通用「待迁移」占位。
- `web/src/App.svelte`：接入 `parseRoute`，`/w/:slug` → WorkspaceScreen，`/w/:slug/wb/...` → EditorScreen（07h），根路径 bootstrap 后 `replaceState` 到 `/w/:slug`；popstate / pushState 驱动。

页面 inventory 归属：

| Legacy screen | 现状 | 归属 |
|---|---|---|
| `HomeScreen` | 已迁 `web/src/screens/HomeScreen.svelte`（真实列表+搜索+空白文档），路由 `/w/:slug` | 完成 |
| `MyDocsScreen` | 入口保留（侧栏「我的文档」→ `/w/:slug/docs`），当前复用 HomeScreen 列表；目录树/拖拽降级 | folder 模型与目录树留后续 issue |
| `SideNav` | 已迁 `web/src/components/SideNav.svelte`，全部可见入口保留 | 完成（folder 子树除外） |
| `TemplatesScreen` | `/w/:slug/templates` 占位「模板创建待迁移」 | 后续模板 issue |
| `DashboardScreen` | `/w/:slug/dashboard` 占位「仪表盘即将上线」 | D3 |
| `AdminScreen` | `/w/:slug/admin` 占位「工作区设置待迁移」 | 后续接 Workspace Scope Module 成员管理 |
| `SettingsScreen` | `/w/:slug/settings` 占位「个人设置待迁移」 | 后续设置 issue（不再调 legacy RPC） |
| `PublicFormScreen` | `/form` / `/form-success` 占位，可访问、带返回登录 | 后续公开表单 issue |
| `ResearchWindowScreen` | 不在主导航；无入口 | 后续资源检索 issue |
| `StateScreen` | 空/离线/无权限态由 `EmptyState` + App 的连接错误态覆盖 | 通用组件已具备 |
| `AdminConsoleScreen` | 不作普通用户入口，无导航入口 | 不暴露（如需 dev-only 再单独显式加） |

仍属后续（非 07i 范围）：D2-08 AI 抽屉；07g 字段管理半边（FieldsModal/列持久化）；workbook/sheet 重命名、folder 目录树；模板/设置/成员/回收站/公开表单真实功能；D2-09 删 `web/legacy/`。

验收：`bun test ./src` 167 pass；`pnpm run typecheck` 0 error；`pnpm run build` 通过；全仓 `from "electrobun` / `electrobun/` 零命中；`web/src` 无 legacy/appApi/app-state import。
