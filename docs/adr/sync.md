# ADR: localdb 与 remote SurrealDB 之间的同步方案

- **Status**: Accepted
- **Date**: 2026-05-11
- **Scope**: `src/main/db`、`schema/main.surql`、所有 RPC mutation handlers、DDL 入口（data-table-runtime 等）

## Context

应用使用两个 SurrealDB 实例：

- **本地（localdb）**：`@surrealdb/node` embedded，SurrealKV 后端，路径按用户分库（`u_<hash>`）。embedded 以 root 权限运行，`$auth = NONE`，schema PERMISSIONS 形同摆设。
- **远端（remote）**：SurrealDB Cloud (`wss://cuckoox-….aws-usw2.surreal.cloud`)，OIDC JWT 鉴权，PERMISSIONS 真正生效。namespace `main`、database `docs`。

需要回答的核心问题：

1. 谁是 source of truth？
2. 写入怎么走？读出怎么走？
3. 多设备/多成员协作下的冲突处理？
4. 离线下的写入暂存与恢复？
5. ent_* 动态实体表的 DDL 怎么同步？
6. 哪些表上云、哪些表纯本地？

约束：

- 远端 record 用户**没有 DEFINE 权限**。所有远端 DDL 必须经由代理接口 `POST https://auth.maplayer.top/api/db/execTemplate { id, params }` 执行预定义模板。
- 用户必须先 OIDC 登录拿到 JWT 才能与应用交互。
- 业务上既存在单机使用，也存在 workspace 多成员共同编辑同一份业务数据。

## Decision

### 1. 拓扑

- **远端 = source of truth**；本地 = 可工作的离线缓存 + 设备私有数据（token、AI memory、observability、查询缓存）。
- 写入冲突时远端赢。
- 多设备协作以远端为唯一可信副本，本地保证离线可用与低延迟读。

### 2. 同步原语

**用 SurrealDB 的 CHANGEFEED + SHOW CHANGES，双向对称**，不解析 SQL、不拦截业务代码：

- 本地表全部带 `CHANGEFEED 7d`。
- 远端同步表全部带 `CHANGEFEED 7d`（由 maintainer 通过 execTemplate 部署 schema 时声明）。
- 后台两个 worker：
  - **本地 → 远端**：500ms 轮询，空闲 5s。`SHOW CHANGES FOR TABLE xxx SINCE $local_cursor`。
  - **远端 → 本地**：2s 轮询，空闲 5s。`SHOW CHANGES FOR TABLE xxx SINCE $remote_cursor`。
- 不使用 LIVE SELECT。

### 3. echo 防护

所有同步表加 `_origin_session_id TYPE string`：

- 进程启动时生成本机 sessionId（ULID）。
- 本地用户写入通过 `DEFINE PARAM $current_session_id` + 表级 `DEFINE EVENT` 自动注入；业务代码不必显式赋值。
- 同步 worker 把远端变更 apply 到本地时，显式写 `_origin_session_id = 'remote:<远端 versionstamp>'`（apply 路径走 raw query 并禁用 EVENT 默认值）。
- 本地 → 远端 worker 读 `SHOW CHANGES` 时跳过 `_origin_session_id` 以 `remote:` 开头的变更。

> 验证项：SurrealDB 当前版本中 `DEFINE PARAM` 是否跨 session 持久；EVENT 中读取 PARAM 的方式；CHANGEFEED 中 `_origin_session_id` 字段变更是否会进流。落地实现前需要写一个最小可行 demo 验证。

### 4. 冲突解决

- 多用户改同一记录：**字段级 MERGE**，后到者只覆盖自己改过的字段。同字段并发仍是 LWW。
- worker apply 远端变更到本地前，**检查本地是否有同 recordId 的未推送 changefeed 项**，有则仅 merge 不冲突字段（保留本地未推送的修改）。
- outbox 中同 recordId 多次连续修改自然由 SurrealDB CHANGEFEED 聚合，worker 取最后状态 push 即可（无需自建 outbox 表）。

### 5. id 与时钟

- 所有同步表的 id 使用客户端 ULID。
- `updated_at` 保留 `VALUE time::now()`（远端服务器时钟）。
- cursor 用 `versionstamp` 而不是 `updated_at`，避免应用层做时钟一致性。

### 6. 同步范围

**同步表**（remote ↔ local）：

- workspace, app_user, has_workspace_member, pending_workspace_member
- workbook, folder, sheet, edge_catalog
- mutation, snapshot, presence
- ent_* 动态实体表, rel_* 关系表
- dashboard_page, dashboard_view
- form_definition, intake_submission, workbook_file
- research_session, resource_item, resource_embedding
- client_error
- app_setting（仅 sensitive = false 的行；推送前过滤）

**仅本地**：

- token_store, app_meta
- mastra_memory_resource, mastra_memory_thread, mastra_memory_message
- mastra_workflow_run
- mastra_observability_span, mastra_observability_event_raw
- dashboard_result_cache, dashboard_run_log
- sync_cursor, sync_dead_letter
- app_setting（sensitive = true）

新增同步表必须显式声明 `syncScope`，默认 fail-closed（不同步）。

### 7. DDL

- 所有远端 DDL 走 `POST https://auth.maplayer.top/api/db/execTemplate { id, params }`。
- 模板文件以仓库 `templates/<template-id>.sql` 命名，maintainer 部署到代理服务。
- 流程：用户在 UI 触发 schema 编辑 → 客户端调 execTemplate → 成功后本地 DEFINE → UI 反馈。
- 离线时禁用 schema 编辑按钮，提示"需联网"。
- 已知需要的模板（初版清单，按需扩充）：
  - `app.schema-upgrade-v<n>`：远端基础 schema 升级
  - `workbook.create`、`sheet.create`
  - `ent.create`、`ent.field-add`、`ent.field-overwrite`、`ent.field-remove`
  - `rel.create`、`rel.field-add`
- 新增 `schema_version` 远端表（所有人可读、root 可写），客户端启动读取版本，不匹配时强制本地-only 模式 + 提示客户端升级。

### 8. 失败处理

- **网络/5xx**：cursor 不前进，下次轮询继续；指数退避 1s / 4s / 16s / 1min / 5min / 30min，无上限。
- **远端语义拒绝**（PERMISSIONS / FK / schema mismatch）：
  - 记录到本地表 `sync_dead_letter`（保留原始 versionstamp、record、错误信息）。
  - cursor 跳过该条。
  - 主动从远端 `SELECT * FROM record:id` 把权威状态回拉覆盖本地，避免长期发散。
- DDL execTemplate 失败：客户端 UI 报错，本地不变更，**不入 dead-letter**（DDL 没有"重试"语义，由用户决定下一步）。

### 9. 离线策略

- 启动时 `tryRestoreSession` 失败 → 进 offlineMode → worker 暂停 → 业务读写仍走本地。
- 本地 CHANGEFEED 7 天保留期。如果离线超 7 天，启动时本地 cursor 滞后于本地 changefeed 起点 → 不阻塞应用，但状态栏强提示"本地有未推送变更，请上云后检查"，并保留信息供用户决定是否手动修复。
- 远端 cursor 超 7 天 → 强制全量重建本地同步表：清空、`SELECT *` 从远端逐张表拉、重置 remote_cursor。

### 10. UI 状态

应用顶部状态栏：

- 在线 / 离线
- 待推送变更数（来自 `SHOW CHANGES SINCE $local_cursor LIMIT 100` 的 count）
- dead-letter 数（点击进入错误列表，提供"忽略"和"以远端覆盖本地"两个操作）

## Schema 变更清单（落地需要做的）

1. `schema/main.surql`：
   - 同步表全部加 `CHANGEFEED 7d`
   - 同步表全部加 `_origin_session_id TYPE string` 字段
   - 同步表全部加 `DEFINE EVENT` 自动注入 `_origin_session_id`
   - 新增 `schema_version`、`sync_cursor`、`sync_dead_letter` 表（前者远端，后两者仅本地）
2. `src/main/db/index.ts`：
   - 启动时 `DEFINE PARAM OVERWRITE $current_session_id VALUE "<ulid>"`
   - 新增 `applyRemoteChange(...)` 入口（绕过默认 EVENT、显式写 `_origin_session_id`）
3. `src/main/sync/`（新模块）：
   - `local-to-remote-worker.ts`
   - `remote-to-local-worker.ts`
   - `dead-letter.ts`
   - `cursor.ts`
4. `src/main/services/data-table-runtime.ts`：DDL 路径改为先调 execTemplate → 再本地 DEFINE
5. `templates/`：新建模板目录，按上面清单准备文件
6. `src/main/services/sync-state.ts`：暴露 sync 状态供 RPC 推到 WebView 状态栏

## Consequences

**好处**

- 业务代码（RPC handlers、Mastra tools、services）完全不需要改写入路径。
- 同步层用 SurrealDB 原生能力，不解析 SQL、不维护手写 outbox。
- 双向对称模型让调试和推理简单。
- 字段级 MERGE 让多成员协作下的并发编辑不互相 clobber。
- DDL 经过代理服务，远端安全（用户不能任意 DEFINE / REMOVE）。

**代价/风险**

- `_origin_session_id` 机制依赖 SurrealDB 的 PARAM + EVENT + CHANGEFEED 组合行为，落地前必须 demo 验证；如不可行需要回退到"显式两种入口"模型（即 worker 维护 applied versionstamp 短缓存）。
- 轮询模型固有延迟（写入 ~500ms 内别人可见、读取 ~2s 内反映远端）；产品上接受。
- 离线 schema 编辑被禁用是产品体验取舍。
- 模板清单的维护成本：每次新加一类 schema 演化需要 maintainer 发布模板。

**未决（落地阶段再敲）**

- `DEFINE PARAM` 在 `@surrealdb/node` 的 session/connection 生命周期里如何持久。
- EVENT 中读取 PARAM 的语法验证。
- CHANGEFEED 中 `_origin_session_id` 自身的变更如果也被记录，会不会自循环触发。
- workspace 退出 / 被踢出场景下，本地"前 workspace 数据"的清理时机（应在 remote→local worker 看到 has_workspace_member 删除时触发本地清理）。
- 大批量首次同步（新设备登录）的进度可视化与可中断性。
