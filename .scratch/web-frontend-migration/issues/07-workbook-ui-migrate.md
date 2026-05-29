Status: in-progress
Label: needs-triage

# WP-D2-07 — Workbook 主界面迁入（直连 SurrealDB）

> 进度（2026-05-29）：**直连数据层已 TDD 完工**（`web/src/lib/workbook-data.ts` +
> `SurrealConn` 扩 query/liveTable/updateRecord/createRecord）。
>
> 本 issue 现作为 **umbrella**：组件层已拆成 07a–07h 八个 sub-issue（见下）。
> 全部 sub-issue 收口后本 umbrella 的验收项自然达成，届时关闭本 issue。
> Dashboard（看板/图表）整套**不在本簇**，拆到独立簇
> `.scratch/web-dashboard-migration/`（依赖本簇跑通）。
>
> ## 组件层拆解（依赖顺序）
>
> | sub | 主体 | 依赖 |
> |---|---|---|
> | 07a | editorStore 重写到直连数据层（迁移 seam）+ deleteRows + drafts 搬迁 | 数据层（已完工） |
> | 07b | editorUi/registries/纯逻辑搬迁 + Workbook/Sheet 导航直连 | 07a |
> | 07c | Grid 外壳（RevoGrid + Vite worker）+ GridView（渲染/编辑/LIVE 主路径） | 07a |
> | 07d | 其余视图 Form / Gallery / Kanban | 07a, 07c |
> | 07e | 引用字段（reference）直连化 + ReferenceCell/Panel/RecordPicker | 07a, 07c |
> | 07f | 工具条面板 Filter / Sort / Group（驱动 viewParams） | 07a, 07c |
> | 07g | 字段管理（defineField）+ 记录详情/表单/弹窗 | 07a, 07c, 07e |
> | 07h | EditorScreen 装配 + 路由 `/w/:slug/wb/...` + electrobun 清零 | 07b–07g |
>
> seam 策略：07a 把组件唯一依赖的中心 store 重写到 `workbook-data.ts`，公共面
> 与 legacy 对齐，后续 07b–07g 每个组件几乎只改 import 路径，迁移平滑。

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

把 `web/legacy/` 中既有 Svelte 5 + RevoGrid 工作簿 / 数据表 / 表视图 UI 搬到 `web/src/`：

- 路由：`/w/:slug/wb/:workbookId` 显示工作簿；`/w/:slug/wb/:workbookId/sheet/:sheetId` 切换数据表。
- 所有原 Electrobun RPC 调用替换为 `getSurreal()` 调用（issue 03 暴露的）：
  - 读 schema / 数据：`db.query('SELECT * FROM ent_xxx WHERE ...')`。
  - LIVE 更新：`db.live('ent_xxx')` 直接回调 Svelte `$state`，**无后端转发**。
  - 单元格编辑：`db.update(recordId, patch)`，PERMISSIONS 由 DB 兜底。
  - 管理员加字段：`db.query('DEFINE FIELD foo ON TABLE ent_xxx TYPE string')`（admin access 自动放行）。
- 删除任何 `import 'electrobun/...'`。
- RevoGrid worker 路径配置确认（Vite 静态资源处理）。

## Acceptance criteria

- [ ] 访问 `/w/:slug/wb/:workbookId` → RevoGrid 渲染 + 直接从 SurrealDB SELECT 加载数据表。（数据层 `loadSheet` 就位；RevoGrid 组件 + 路由待搬）
- [~] 单元格编辑 → SurrealDB UPDATE 直达，无后端跳跃；其它 tab LIVE 订阅同表能立即看到变化。（`saveCells`→updateRecord/createRecord + `subscribeLive`→liveTable 已 TDD 完工；接到组件待搬）
- [~] 管理员能用浏览器 console / UI 加字段 → `DEFINE FIELD` 成功，刷新后字段出现。（`defineField` 已完工；UI 入口待搬）
- [x] 普通成员尝试加字段 → SurrealDB 引擎层拒绝（RECORD access 无 DDL），UI 给出明确错误。（`describeWriteError` 把权限错误翻成中文提示，单测覆盖）
- [ ] Console 无 Electrobun import 报错。（组件层搬迁时处理）
- [x] svelte-check 0 错误。（`pnpm run typecheck`：0 errors 0 warnings）

## Blocked by

- `.scratch/web-frontend-migration/issues/03-surrealdb-direct-client.md`

## Notes

- 既有 RevoGrid 配置原样搬即可；Web Component 在 Vite 8 中的 polyfill 问题若出现单独立 issue。
- LIVE 订阅在组件 onMount 启、onDestroy 关，防泄漏。
- 大量数据滚动加载用 SurrealDB `LIMIT` + `START`；切忌一次性 SELECT 整表。
