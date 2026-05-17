Status: needs-triage
Label: needs-triage

# WP-D2-07 — Workbook 主界面迁入（直连 SurrealDB）

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

- [ ] 访问 `/w/:slug/wb/:workbookId` → RevoGrid 渲染 + 直接从 SurrealDB SELECT 加载数据表。
- [ ] 单元格编辑 → SurrealDB UPDATE 直达，无后端跳跃；其它 tab LIVE 订阅同表能立即看到变化。
- [ ] 管理员能用浏览器 console / UI 加字段 → `DEFINE FIELD` 成功，刷新后字段出现。
- [ ] 普通成员尝试加字段 → SurrealDB 引擎层拒绝（RECORD access 无 DDL），UI 给出明确错误。
- [ ] Console 无 Electrobun import 报错。
- [ ] svelte-check 0 错误。

## Blocked by

- `.scratch/web-frontend-migration/issues/03-surrealdb-direct-client.md`

## Notes

- 既有 RevoGrid 配置原样搬即可；Web Component 在 Vite 5 中的 polyfill 问题若出现单独立 issue。
- LIVE 订阅在组件 onMount 启、onDestroy 关，防泄漏。
- 大量数据滚动加载用 SurrealDB `LIMIT` + `START`；切忌一次性 SELECT 整表。
