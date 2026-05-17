# workspace-as-database 身份层 PRD（簇 C，2026-05-17 大幅缩水版）

更新时间：2026-05-17

依据：
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)
- [`docs/adr/frontend-direct-connect.md`](../../docs/adr/frontend-direct-connect.md)
- [`docs/adr/backend-framework-hono.md`](../../docs/adr/backend-framework-hono.md)
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)

## 一句话

把"workspace ↔ database 映射 + 三类身份的 access"模型落地。**绝大部分原 issue 已废除**——sessions / members / workspaces 创建 endpoint 全部由前端直连 SurrealDB + IdP 取代。本簇缩水为：`_system` schema seed + workspace 模板 SQL（前后端共享）+ schema migration runner（仅后端用，处理既有 db 增量）+ IdP webhook 同步钩子 + reconciler。

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

- `_system` database 有 `workspace` + `user_workspace_index` 两表（root-only，无 access）。
- `shared/sql/workspace-template/*.surql` 文件就位——**前端 bundle 进自己代码用于创建新 db；后端 schema migration runner 用于既有 db 增量**。
- `POST /api/internal/workspace-created` webhook：接受 IdP 通知，root 写 `_system.workspace` + `_system.user_workspace_index`。
- `POST /api/internal/membership-changed` webhook：接受 IdP 通知，root 改 `_system.user_workspace_index`。
- 启动期 schema migration runner：遍历 `_system.workspace`，对每个 ws db 应用 `shared/sql/workspace-template/` 中未应用的增量。
- 启动期 reconciler：用 root + IdP 全量拉取一次，校对 `_system` 是否与 IdP 一致；漂移项写日志。

## 不再做（已被前端直连 + IdP 取代）

- ❌ `create_workspace` execTemplate
- ❌ `POST /api/workspaces`（创建 workspace 由 IdP + 前端 DDL）
- ❌ `GET /api/sessions/bootstrap`（workspace 列表由 IdP 直接告诉前端）
- ❌ `POST /api/sessions`（前端直接 `db.signin` SurrealDB）
- ❌ `POST/DELETE/PATCH /api/workspaces/:slug/members/*`（管理员浏览器内直接 INSERT/UPDATE/DELETE user 表 + 调 IdP）
- ❌ `GET /api/workspaces/:slug/members`（前端直接 SELECT user 表）

## 风险

- **IdP webhook 鉴权**：webhook 接口暴露在公网，必须用共享密钥 / mTLS 防伪造。
- **IdP webhook 丢消息**：reconciler 启动期 pull IdP 全量做兜底。
- **前端 + 后端两套 schema migration runner 必须共享同一 SQL 文件**：靠 `shared/` workspace 强制；如果不一致会有"老 db 缺字段"症状。
- **workspace 创建路径的原子性**：浏览器先 DDL 再调后端 webhook、还是 IdP 直接 webhook 后端？本簇接受"IdP webhook 推后端"作为权威，浏览器 DDL 失败时 IdP 不发 webhook + 浏览器自行 `REMOVE DATABASE` 回滚。

## Issue 路线图（重排后）

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | _system schema seed | 启动时确保 workspace / user_workspace_index 两表存在；幂等；schema_version 表 | server-skeleton 全部 |
| 02 | workspace 模板 SQL 文件 | shared/sql/workspace-template/ 三个 .surql：三条 access + user + office_role + employee_credential；前后端共享 | 01 |
| 03 | IdP webhook endpoint | POST /api/internal/workspace-created + membership-changed；共享密钥鉴权 | 01, 02 |
| 04 | schema migration runner | 启动期遍历 _system.workspace，对每个 ws db 应用未应用的增量 .surql | 02 |
| 05 | reconciler | 启动时 + 每小时 pull IdP 全量校对 _system；漂移写日志 | 03 |

issue 列表从 7 个收缩到 5 个。

## 验收 KPI

- 后端启动 → _system 两表 + schema_version 落地。
- 模拟 IdP 发 webhook → _system.workspace 与 user_workspace_index 出现对应行。
- 在 shared/sql 加 `004-foo.surql` → 重启后所有 ws db 都跑到新版本。
- 故意让 IdP webhook 丢一条 → reconciler 在启动期补回缺失的索引行。
- 后端日志中 root 凭证使用面与 frontend-direct-connect §5 列表一致（启动 schema + webhook + dispatcher 启动遍历）。
