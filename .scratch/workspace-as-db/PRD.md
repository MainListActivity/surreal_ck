# workspace-as-database 身份层 PRD（簇 C）

更新时间：2026-05-17

依据：
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)
- [`docs/adr/frontend-direct-connect.md`](../../docs/adr/frontend-direct-connect.md)
- [`docs/adr/backend-framework-hono.md`](../../docs/adr/backend-framework-hono.md)
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)

## 一句话

把"workspace ↔ database 映射 + 三类身份 access + Workspace Scope Module"落地。业务数据仍由前端直连 SurrealDB；后端保留必要的 scope / lifecycle endpoint：列 workspace、切换 workspace、IdP 登录 hook 默认 scope、创建 workspace、维护 `_system.user_workspace_index`。

## 当前不解决

- 虚拟办公室协作四表（virtual-office issue 02）
- 虚拟员工 provisioning（virtual-office issue 03）
- dispatcher（virtual-office issue 04+）
- Mastra Router workflow 迁入（簇 D1）
- 前端 UI、OIDC、Workspace 切换器（簇 D2）

## 前置条件

- 簇 A 完成（pnpm workspaces 就位）
- 簇 B 完成（Hono / root 连接 / OIDC verify 中间件就绪）

## 完成定义

- `_system` database 有 `workspace` + `user_workspace_index` + `_system_schema_version`（root-only，无 access）。
- `shared/sql/workspace-template/*.surql` 文件就位；后端创建新 workspace 和迁移既有 workspace 都使用同一份模板。
- Workspace Scope Module 就位：
  - `GET /api/session/workspaces`
  - `POST /api/session/switch-workspace`
  - `GET /api/internal/idp/default-scope`
  - IdP Token Scope Adapter（更新 `https://surrealdb.com/db` / `https://surrealdb.com/ac`）
- `POST /api/workspaces` 创建 workspace：root 建 db、应用模板、创建 owner user、写 `_system` 索引、调用 IdP scope adapter。
- 启动期 schema migration runner：遍历 `_system.workspace`，对每个 ws db 应用 `shared/sql/workspace-template/` 中未应用的增量。
- Reconciler：校对 `_system.user_workspace_index` 与 workspace db `user` 表是否漂移，输出日志或修复可安全修复项。

## 不再做

- ❌ 浏览器 NS-admin token。
- ❌ 前端执行 `DEFINE DATABASE` 创建 workspace。
- ❌ IdP 维护 workspace 列表 / 成员关系。
- ❌ 业务数据代理 endpoint（工作簿、数据表、office_* CRUD / LIVE 转发）。
- ❌ service JWT / 代写模式。

## 风险

- **IdP scope adapter 失败**：workspace 已创建但 token scope 没切成功时，前端需要明确提示并允许重试切换。
- **成员索引漂移**：workspace db `user` 与 `_system.user_workspace_index` 必须同步维护；成员管理路径需要后续 issue 固化。
- **workspace 创建补偿**：模板执行失败要删除刚创建的 db；删除失败要有日志和手工修复指引。
- **前后端共享模板**：创建新 db 与迁移既有 db 必须使用同一套 `shared/sql/workspace-template/`。

## Issue 路线图（重排后）

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | _system schema seed | 启动时确保 workspace / user_workspace_index / _system_schema_version 表存在；幂等 | server-skeleton 全部 |
| 02 | workspace 模板 SQL 文件 | shared/sql/workspace-template/：三条 access + user + office_role + employee_credential；后端创建和迁移共用 | 01 |
| 03 | Workspace Scope Module | `/api/session/workspaces`、`switch-workspace`、IdP default-scope hook、IdP scope adapter | 01, 02 |
| 04 | schema migration runner | 启动期遍历 _system.workspace，对每个 ws db 应用未应用的增量 .surql | 02 |
| 05 | reconciler | 启动时 + 每小时校对 _system index 与 workspace db user 表；漂移写日志 / 安全修复 | 03 |
| 06 | workspace create lifecycle | `POST /api/workspaces`：root 建 db、应用模板、写 owner 和 _system、切 token scope | 02, 03 |

## 验收 KPI

- 后端启动 → _system 三类表落地，重复启动幂等。
- 登录 hook 模拟请求 → 对已有 subject 返回最近选择的 `{ db, ac }`；无 workspace 返回拒绝登录。
- `POST /api/session/switch-workspace` 对无权限 workspace 返回 403，对有权限 workspace 更新 `last_selected_at` 并调用 IdP scope adapter。
- `POST /api/workspaces` 成功后新 db 有模板 schema、owner user、_system 索引，并且 token scope 切到新 workspace。
- 在 shared/sql 加 `004-foo.surql` → 重启后所有 ws db 都跑到新版本。
