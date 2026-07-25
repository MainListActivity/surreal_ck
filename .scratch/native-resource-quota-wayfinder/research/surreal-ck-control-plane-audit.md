# surreal_ck 现有配额与控制面迁移边界审计

## 结论摘要

当前配额不是订阅系统，也不是 SurrealDB 原生资源限制；它是 workspace database 内的三组静态套餐记录、两组用量记录和 `DEFINE EVENT` 组成的应用内闸门。它能保护 surreal_ck 的正常建表、改字段和写记录路径，并借助事务回滚避免正常路径留下半成品，但它计量的是 `sheet` / `column_defs` 业务元数据与挂过事件的动态表记录，不是数据库引擎实际持有的表、字段和记录资源。

现有实现不能作为面对恶意 workspace 管理员的计费边界：管理员通过 `admin` JWT access 获得 SurrealDB `Owner`，浏览器既能直接执行动态 DDL，也有原始 SurrealQL 控制台；因此可以修改 workspace 内的套餐或用量记录、移除事件，或者绕开 `sheet` 元数据直接创建资源。仓库文档也已经明确记录了这一信任边界（[`docs/resource-quotas.md`](../../../docs/resource-quotas.md#L46-L53)）。

原生配额上线后的清晰迁移边界是：

- 删除应用层事件闸门及其安装、回填和字符串错误契约；
- 保留 workspace root 生命周期、模板迁移框架、浏览器直连数据路径和现有 DDL 事务原子性；
- 把“Plus / Pro / Max 是什么、某 workspace 当前拥有什么权益”迁往尚待确定的订阅/权益权威模型；
- 让 surreal_ck 通过稳定的跨仓契约给原生引擎声明策略、读取用量并解释结构化错误；
- workspace 内若继续保留套餐或用量数据，只能作为可重建的展示投影，不能继续充当授权或计费权威。

本报告只盘点代码边界及迁移影响，不决定套餐资源口径、订阅权威落点、原生 SurrealQL 语法、Owner 是否拥有配额管理权或降级语义。

## 审计范围与快照

- 仓库：`/Users/y/IdeaProjects/surreal_ck`
- 分支：`main`
- HEAD：`d31d22901fb20edf27f139b32cf83c564f0c6c9a`
- 审计日期：2026-07-24
- 第一手来源：当前源码、workspace / `_system` SurrealQL 增量、ADR、单元测试和本机 SurrealDB CLI 集成测试。
- 搜索范围覆盖 `server/`、`web/`、`shared/`、当前 ADR 与配额文档；同时检查根、server、web、shared 四个 `package.json` 及 lockfile 中是否有 billing / payment / subscription provider。

## 1. 当前配额模型

### 1.1 三类套餐是 workspace 内的静态 seed

`020-resource-quota.surql` 在每个 workspace database 中创建三张业务控制表：

| 表 | 当前角色 | 初始内容 |
|---|---|---|
| `resource_quota_plan` | 套餐额度 | `plus`、`pro`、`max` 三行 |
| `workspace_resource_quota` | 当前 workspace 的套餐绑定及 `sheet_count` | 固定记录 `:current`，默认绑定 Plus |
| `sheet_resource_usage` | 每张 `sheet` 对应动态实体表的记录计数 | 每个 sheet 一行 |

套餐只包含 `max_sheets`、`max_fields_per_sheet`、`max_records_per_sheet`，初始值分别为 Plus `1/3/2`、Pro `2/6/4`、Max `3/9/6`（[`020-resource-quota.surql`](../../../shared/sql/workspace-template/020-resource-quota.surql#L6-L49)）。`workspace_resource_quota:current` 在模板执行时默认绑定 `resource_quota_plan:plus`，并用当时的 `sheet` 数量初始化 `sheet_count`（[同文件](../../../shared/sql/workspace-template/020-resource-quota.surql#L51-L74)）。

同一组数值还重复存在于 TypeScript 常量 `RESOURCE_QUOTA_PLANS` 中（[`shared/src/resource-quota.ts`](../../../shared/src/resource-quota.ts#L3-L21)）。当前没有生成步骤保证 TS 常量与 SurrealQL seed 一致；集成测试同时消费两者，漂移时通常会表现为测试失败，但运行时没有一致性检查。

### 1.2 “数据表”和“字段”按业务元数据计量

`sheet.resource_quota_guard` 事件：

- `CREATE sheet` 时检查 `column_defs` 长度，再用带 `WHERE sheet_count < plan.max_sheets` 的条件更新预留一个数据表名额；
- `UPDATE sheet` 时，只在 `column_defs` 长度增加且超过上限时拒绝；
- `DELETE sheet` 时递减 `sheet_count` 并删除该 sheet 的记录用量行。

证据见 [`020-resource-quota.surql`](../../../shared/sql/workspace-template/020-resource-quota.surql#L91-L123)。

因此当前口径实际是：

- “表数” = `sheet` 业务记录数，而非 SurrealDB database 中实际定义的 table 数；
- “字段数” = `sheet.column_defs` 数组长度，而非 `INFO FOR TABLE` 中实际定义的 field 数。

这会产生结构性差异：直接 `DEFINE TABLE` 不增加 `sheet_count`，直接 `DEFINE FIELD` 不增加 `column_defs`；反过来，删除 `sheet` 会释放名额，但事件本身不负责 `REMOVE TABLE`。这些不是偶然遗漏，而是当前实现选择了业务元数据作为计量面。

### 1.3 “记录数”按每张动态表的事件计量

动态实体表无法在静态模板中逐张预定义事件，因此共享模块运行时拼接：

```surql
DEFINE EVENT OVERWRITE resource_quota_guard ON TABLE <ent_*>
```

事件在记录 `CREATE` 时条件递增 `sheet_resource_usage.record_count`，没有成功预留行就 `THROW "quota-records-exceeded"`；记录 `DELETE` 时递减（[`shared/src/resource-quota.ts`](../../../shared/src/resource-quota.ts#L31-L62)）。

这意味着记录限制只覆盖：

- 经 surreal_ck 创建、且成功安装该事件的动态实体表；
- `CREATE` / `DELETE` 事件能观察到的记录变化。

它不天然覆盖其他表、被移除事件的表，或者脱离 surreal_ck 元数据生命周期创建的表。

### 1.4 当前“并发安全”是应用事件内的条件预留

表和记录闸门都把“检查上限 + 用量递增”写成事件事务内的一次条件 `UPDATE`，失败则 `THROW`，调用方事务整体回滚。这个结构避免了明显的应用层 `SELECT count()` 后 `INSERT` 检查窗口。

但当前测试只验证临界值、回滚和动态改额度，没有并发压测或多个客户端同时争抢最后一个额度的测试。因此可以确认的是“实现意图为事务内条件预留”，不能从现有测试进一步宣称已经证明所有后端上的并发线性化语义。

## 2. 配额进入动态 DDL / DML 路径的位置

### 2.1 新建工作簿：浏览器事务同时创建物理表、事件和元数据

`buildCreateWorkbookTransaction` 为每张业务数据表生成：

1. `DEFINE TABLE ent_*`;
2. 系统字段和业务字段 `DEFINE FIELD`;
3. `resource_quota_guard`;
4. `record_activity`;
5. `CREATE sheet` 元数据。

全部包在同一个 `BEGIN TRANSACTION` / `COMMIT TRANSACTION` 中（[`web/src/lib/workbooks.ts`](../../../web/src/lib/workbooks.ts#L395-L430)）。所以正常创建路径下：

- `sheet` 事件负责表数 / 字段数；
- 动态表事件负责以后写入的记录数；
- 任一 DDL、配额事件或元数据写入失败都会回滚整个工作簿创建。

这个事务结构本身仍有价值；原生配额上线后只需移除“为每张表安装配额事件”这一步，而不是拆散事务。

### 2.2 字段编辑：浏览器事务同时写 DDL 与 `column_defs`

数据表运行时把字段 `DEFINE FIELD OVERWRITE`、移除字段前的数据清理、`REMOVE FIELD` 和 `sheet.column_defs` 更新放在同一 SDK 事务中（[`web/src/lib/data-table-runtime.ts`](../../../web/src/lib/data-table-runtime.ts#L488-L537)）。这保证正常 UI 路径中物理 schema 与配额所读元数据同步。

原生字段配额上线后，这个事务仍应保留；引擎会直接对 DDL 进行限制，`column_defs` 只继续承担业务展示和输入 schema 元数据职责，不再参与计费。

### 2.3 记录写入：浏览器直连 SDK

数据表运行时直接用当前 workspace 连接执行 `createRecord` / `updateRecord` / `deleteRecord`；CSV 导入也是逐行 `createRecord`（[`web/src/lib/data-table-runtime.ts`](../../../web/src/lib/data-table-runtime.ts#L347-L428)）。连接由浏览器拿 OIDC access token 直连目标 database（[`web/src/lib/surreal.ts`](../../../web/src/lib/surreal.ts#L245-L270)）。

这条路径不会经过 Bun HTTP middleware，因此未来原生 `QuotaExceeded` 必须能通过 `surrealdb-js` 稳定到达浏览器，不能只设计 Hono 层错误。

## 3. 现有信任边界与可绕过点

### 3.1 workspace 管理员是 database system Owner

当前 `admin` access 是 `TYPE JWT`（[`001-access.surql`](../../../shared/sql/workspace-template/001-access.surql#L1-L18)）；IdP 固定注入 `RL=['Owner']`，仓库明确记录 `admin` 因而获得 DDL + DML，participant RECORD access 则没有 DDL（[`docs/oidc.md`](../../../docs/oidc.md#L48-L68)）。

虽然三张配额控制表对 create / update / delete 写了 `PERMISSIONS NONE`，Owner 不受普通 record permissions 约束。因而这些权限声明不能阻止 workspace 管理员修改套餐、修改计数或移除事件。

### 3.2 浏览器不仅有受控 DDL，还有任意 SurrealQL 控制台

除工作簿和数据表运行时的受控 DDL 外，管理员 SQL 控制台直接把输入交给 `getSurreal().queryRaw(trimmed)`（[`AdminConsoleScreen.svelte`](../../../web/src/screens/AdminConsoleScreen.svelte#L37-L63)）。UI 角色检查只是可用性门槛，真正能力来自数据库 Owner。

因此原生引擎与 surreal_ck 的跨仓授权契约必须明确区分：

- tenant workspace 管理员能否定义普通业务 schema；
- tenant workspace 管理员能否读取配额和用量；
- tenant workspace 管理员能否定义、修改、移除配额；
- instance / namespace / 平台 root 如何下发配额。

在这个契约明确之前，不能假设“保留 Owner”或“取消 Owner”任一方案已经被本审计决定。

### 3.3 当前每种资源都可通过“计量面 ≠ 引擎面”绕过

| 资源 | 当前计量面 | 引擎实际资源 | 绕过或漂移形态 |
|---|---|---|---|
| 数据表 | `sheet` 记录 | table definition | 直接 `DEFINE TABLE`；删除 sheet 但保留物理表 |
| 字段 | `sheet.column_defs` | field definition | 直接 `DEFINE FIELD`；元数据与 DDL 不同步 |
| 记录 | 动态表事件 + `sheet_resource_usage` | table records | 移除事件；写入未安装事件的表 |
| 套餐 | workspace 内 `resource_quota_plan` / `workspace_resource_quota` | 平台权益 | Owner 直接修改记录 |

`sheet_count` 只在 020 首次应用时按现有 sheet 初始化；之后没有用真实 sheet 重新调和的代码。迁移启动钩子只回算每张动态表的 `record_count`，不回算 `sheet_count`（[`server/src/db/resource-quota.ts`](../../../server/src/db/resource-quota.ts#L45-L78)；[`server/src/db/migration-runner.ts`](../../../server/src/db/migration-runner.ts#L85-L88)）。

## 4. workspace 创建、迁移与 root 控制面

### 4.1 root 连接是现成的可信控制面通道

后端用唯一 root 连接登录 `_system`，并通过 `forkSession()` 派生仍携带 root 身份的 database session；按 namespace/database 缓存在最多 20 个 session 的池中（[`root-connection.ts`](../../../server/src/db/root-connection.ts#L27-L40)；[`root-session-pool.ts`](../../../server/src/db/root-session-pool.ts#L20-L76)）。

当前 root 被 workspace 创建、workspace / 成员管理、系统 schema、workspace migration、reconciler 和 dispatcher 生命周期使用。原生配额策略下发可以复用这条控制面基础设施，无需为配额另造长期 service token；但具体授权层级仍须与 surrealdb fork 的原生权限模型对齐。

### 4.2 新 workspace 默认 Plus 是模板副作用，不是订阅决策

workspace 创建流程：

1. root `DEFINE DATABASE`;
2. 顺序应用全部 `shared/sql/workspace-template/`；
3. 应用模板包；
4. 写 `schema_version:current`;
5. 创建 owner user；
6. 在 `_system` 原子写 `workspace` 与 `user_workspace_index`;
7. 调 IdP scope adapter。

源码见 [`create-workspace.ts`](../../../server/src/workspaces/create-workspace.ts#L140-L229) 和 `_system` 索引事务（[同文件](../../../server/src/workspaces/create-workspace.ts#L233-L264)）。

因为 020 模板固定写 `workspace_resource_quota:current.plan = plus`，所以所有新 workspace 都隐式获得 Plus。创建 API 没有 plan / subscription / entitlement 输入。未来原生配额不能继续依赖模板隐式默认值；workspace 生命周期需要一个显式、可重试、可审计的“读取权益并下发策略”步骤，但它放在哪个事务阶段及失败补偿语义留给后续决策票。

模板或 owner 写入失败时，创建流程尝试 `REMOVE DATABASE`；`_system` 写入失败同样删库；IdP scope 更新失败则保留已创建 database 并返回可重试结果（[`create-workspace.ts`](../../../server/src/workspaces/create-workspace.ts#L193-L229)、[补偿函数](../../../server/src/workspaces/create-workspace.ts#L285-L294)）。新增原生策略下发必须进入这套既有补偿矩阵。

### 4.3 现有 workspace 迁移在服务监听前串行、fail-fast

启动顺序是 root → `_system` schema → system admin seed → 全 workspace migration → HTTP/WS listen（[`server/src/startup.ts`](../../../server/src/startup.ts#L48-L79)）。

workspace migration runner：

- 从 `_system.workspace` 读取全部 `db_name`；
- 串行切换 database；
- 按 `schema_version:current` 应用缺失模板；
- 每个脚本后立即写版本；
- 最新模板版本达到 20 后，不论是否有新脚本，都重新回算已有动态表的记录数并重装事件；
- 单 workspace 失败即中止启动，已经迁完的 workspace 不回滚。

证据见 [`migration-runner.ts`](../../../server/src/db/migration-runner.ts#L53-L101)。

原生配额发布后，策略 schema / 数据迁移可继续复用该框架，但应移除“版本 ≥ 20 就重装事件”的特殊分支。值得单列的现状差异是：`_system.workspace` 已定义 `last_migration_version` / `last_migration_error`（[`001-init.surql`](../../../shared/sql/system/001-init.surql#L1-L16)），当前 runner 却只写各 workspace 的 `schema_version:current`，没有维护这两个 `_system` 字段。

### 4.4 现有 reconciler 不处理配额

`reconcileWorkspaceIndex` 只校对 `_system.user_workspace_index` 与各 workspace `user` 表，处理缺行、subject 和 role 漂移（[`server/src/db/reconciler.ts`](../../../server/src/db/reconciler.ts#L210-L274)）。它没有套餐、策略或用量调和职责。

未来策略 compiler / reconciler 可以复用“遍历 workspace + 单 workspace 隔离失败 + 周期重试”的经验，但不应误认为现有 reconciler 已提供配额幂等性。

## 5. 错误归一现状

### 5.1 当前配额错误只是三个字符串

- `quota-sheets-exceeded`
- `quota-fields-exceeded`
- `quota-records-exceeded`

它们由 SurrealQL `THROW` 进入 driver 错误 message，没有结构化资源类型、scope、limit、usage、requested delta、重试性或稳定错误枚举。

### 5.2 浏览器错误模型尚未认识配额

`DataTableRuntimeErrorCode` 支持 validation、permission-denied、not-found、conflict、unavailable、outcome-unknown、closed、unexpected（[`data-table-runtime.ts`](../../../web/src/lib/data-table-runtime.ts#L36-L60)），但 `classifyError` 只识别权限、not found 和网络类，其余均为 `unexpected`（[同文件](../../../web/src/lib/data-table-runtime.ts#L867-L886)）。所以记录超限在数据表运行时会落到 `unexpected`；CSV 导入只把原始 message 写入拒绝原因。

工作簿创建使用 `describeWriteError`，它只把权限错误翻成中文，配额字符串原样透传（[`workbook-data.ts`](../../../web/src/lib/workbook-data.ts#L86-L93)）。SQL 控制台也直接显示 driver message。

### 5.3 Hono 错误格式不能覆盖直连 DDL / DML

后端已经有 `HttpError(status, code, message, details)` 和统一 `ApiError` 输出（[`http-error.ts`](../../../server/src/http-error.ts#L1-L13)；[`middleware/error.ts`](../../../server/src/middleware/error.ts#L6-L28)），适合未来套餐控制面 endpoint；但业务 DDL / DML 直连 SurrealDB，原生配额错误不会经过这里。

跨仓契约必须同时定义：

- SurrealDB server / core 的稳定错误种类与字段；
- RPC / WebSocket 到 `surrealdb-js` 的保真行为；
- surreal_ck 浏览器 runtime 的领域错误映射；
- 控制面调用原生配额失败时的 Hono `ApiError` 映射。

## 6. 是否已有 subscription / billing 权威模型

结论：没有。

当前仓库只有：

1. workspace 内的三行静态 `resource_quota_plan`；
2. workspace 内固定 `:current` 套餐绑定；
3. shared TS 中重复的 Plus / Pro / Max 数值；
4. root 手工执行的 `assign-plan.surql` 和 `update-plus.surql`（[`assign-plan.surql`](../../../shared/sql/manual/resource-quota/assign-plan.surql#L1-L7)；[`update-plus.surql`](../../../shared/sql/manual/resource-quota/update-plus.surql#L1-L5)）。

没有发现：

- subscription / entitlement / billing / invoice / payment 数据表或领域类型；
- Stripe、Paddle、Lemon Squeezy 等支付 provider 依赖；
- checkout / webhook / renewal / cancellation endpoint；
- 套餐变更 API、幂等事件处理或调和任务；
- 订阅主体与 workspace 的归属模型。

`subscription` 在 web 源码中的其他命中是 SurrealDB LIVE subscription，不是商业订阅。

所以当前 `resource_quota_plan` 不是商业套餐权威，只是每个 workspace 内可手改的配额模板副本。后续“订阅/权益权威模型”必须新建，不能把现有表误当成已存在的 billing domain。

## 7. 原生配额上线后的影响清单

### 7.1 删除：应用层 enforcement 与其安装机制

| 现有资产 | 删除原因 | 替代契约 |
|---|---|---|
| `020-resource-quota.surql` 中 `sheet.resource_quota_guard` | 计量业务元数据，不是引擎资源；Owner 可移除 | 引擎对真实 table / field DDL 原生检查 |
| `buildRecordQuotaGuardSurql` | 每张动态表拼接事件，覆盖不完整 | 引擎对 record create/delete 原生计量 |
| 新工作簿事务中的 `buildRecordQuotaGuardSurql(...)` | 不再需要每表安装 | 保留其余 DDL + metadata 原子事务 |
| `installExistingRecordQuotaGuards` | 启动回算并重装事件是临时迁移胶水 | 一次性原生 usage bootstrap / verify 迁移 |
| migration runner 的 `toVersion >= 20` 特判 | 永久启动成本，且只修记录计数 | 原生策略/usage 版本化迁移 |
| `sheet_count` / `record_count` 作为 enforcement authority | 可漂移、可被 Owner 改 | 原生引擎计数 |
| 三个 `quota-*-exceeded` 字符串契约 | 信息不足且不稳定 | 原生结构化错误 |

这些删除应在原生策略完成迁移、用量校验和兼容切换后发生，而不是提前移除保护。

### 7.2 保留：与配额无关且仍构成正确边界的深模块

| 现有资产 | 保留价值 | 需要适配 |
|---|---|---|
| root connection + database session pool | 已有可信平台控制面 | 调用原生配额管理 API / SurrealQL |
| Workspace Scope Module / create lifecycle | workspace 与 database 一一对应的生命周期权威 | 显式编排权益解析和策略下发 |
| workspace / system schema migration framework | 跨 workspace 版本推进 | 加原生能力探测、rollout 状态和恢复 |
| 浏览器直连 SurrealDB | 业务读写短路径，原生 enforcement 正适合此拓扑 | 解析原生错误与用量 introspection |
| 新建工作簿事务 | DDL、metadata、样例数据原子性 | 移除事件安装，不移除事务 |
| 数据表运行时字段事务 | DDL 与 `column_defs` 业务元数据一致性 | 配额错误映射 |
| `_system.workspace` / membership 索引 | workspace scope 权威 | 可能新增权益投影引用，但不混入用量计数 |
| Hono `HttpError` / `ApiError` | 控制面 API 统一错误 | 增加原生策略失败映射 |

### 7.3 迁移：现有套餐与用量数据

| 当前数据 | 迁移目标性质 | 未在本票决定的事项 |
|---|---|---|
| `resource_quota_plan` 三行 | 套餐 → 权益模板的输入之一 | 权威在 `_system`、独立 billing store 或外部 provider |
| `workspace_resource_quota.plan` | workspace 当前权益的旧投影 | 订阅主体、赠送额度、覆盖优先级、有效期 |
| `workspace_resource_quota.sheet_count` | 一次性对账输入或废弃 | 原生表数口径 |
| `sheet_resource_usage.record_count` | 一次性对账输入或废弃 | 是否保留 per-table 展示粒度 |
| `RESOURCE_QUOTA_PLANS` | 删除重复硬编码，改消费权威 DTO | 套餐值和版本发布机制 |
| 两个 manual SurQL | 替换为受审计、幂等控制面动作 | 管理 UI / webhook / operator 流程 |

如果 UI 仍需要快速显示套餐和用量，可保留新的 workspace 内投影，但必须满足：

- 明确标记 non-authoritative；
- 可从订阅权威 + 原生 `INFO/SHOW` 用量完全重建；
- 任何租户对投影的修改都不能改变引擎 enforcement；
- 投影滞后只能影响显示，不能授予额外资源。

### 7.4 跨仓契约：surrealdb fork 与 surreal_ck 必须共同固定

以下都是接口依赖，不在本审计中选择具体语法或语义：

1. **能力发现**：surreal_ck 如何确认连接的是支持原生配额的 fork 版本及其 schema / error 版本。
2. **策略目标**：namespace、database、table 及可能的 wildcard 如何被稳定标识；workspace `db_name` 如何映射。
3. **管理授权**：instance root、namespace 管理员、database Owner 分别能 DEFINE / ALTER / REMOVE / INFO 哪些配额。
4. **策略写入**：幂等 upsert、策略版本、expected revision、批量应用与原子性。
5. **用量读取**：真实 table / field / record usage 的一致性、刷新时机、精度和分页。
6. **操作 enforcement**：CREATE / INSERT / 批量写入 / 事务 / 删除释放 / rollback 的 requested delta 与最终 usage 语义。
7. **结构化错误**：稳定 code、resource、scope、limit、usage、requested、policy id/version、retryability。
8. **降级超额状态**：只读、禁止增长或其他模式的可观察状态；具体策略由后续票决定。
9. **迁移 bootstrap**：从现有实际 database 扫描初始 usage，而不是信任可篡改的旧计数。
10. **兼容 rollout**：旧 SurrealDB、支持原生配额但未下发策略、双写观察期、回滚到旧版本时分别如何表现。
11. **SDK 保真**：`surrealdb-js` 2.x 客户端能否保留结构化错误；若不能，需要 fork SDK 或协议兼容层。
12. **可观测性**：policy apply、quota denied、usage drift 的日志 / metrics 字段，且不泄漏 root 凭据和 token。

## 8. 测试现状与缺口

### 8.1 已有覆盖

- shared 单元测试固定三档额度、事件文本和动态标识符安全（[`resource-quota.test.ts`](../../../shared/src/resource-quota.test.ts#L8-L38)）。
- server 单元测试覆盖已有动态表记录数回填、事件重装和非法表名拒绝（[`server/src/db/resource-quota.test.ts`](../../../server/src/db/resource-quota.test.ts#L10-L61)）。
- migration runner 单元测试覆盖版本推进、版本 20 重装、无 workspace 和 fail-fast（[`migration-runner.test.ts`](../../../server/src/db/migration-runner.test.ts#L67-L195)）。
- web 单元测试确认新动态表事务包含记录配额事件（[`workbooks.test.ts`](../../../web/src/lib/workbooks.test.ts#L600-L608)）及字段 DDL / metadata 同事务。
- opt-in CLI 集成测试在真实本机 SurrealDB 上覆盖 Plus / Pro / Max 临界值、字段 DDL 回滚、记录上限和动态修改 Plus 表数（[`resource-quota.cli.integration.test.ts`](../../../shared/src/resource-quota.cli.integration.test.ts#L180-L255)）。

### 8.2 本次实际验证结果

本机 `surreal version`：`3.2.3+20260721.40522d1`。

| 命令 | 结果 |
|---|---|
| `pnpm --filter @surreal-ck/shared exec bun test src/resource-quota.test.ts` | 3 pass |
| `pnpm --filter @surreal-ck/server exec bun test src/db/resource-quota.test.ts src/db/migration-runner.test.ts --preload ./test/setup-env.ts` | 8 pass |
| `pnpm --filter @surreal-ck/web exec bun test src/lib/workbooks.test.ts src/lib/data-table-runtime.test.ts` | 36 pass |
| `pnpm run test:quota:local` | 3 pass，55 assertions，真实 CLI 内存实例 |

### 8.3 原生方案需要补的验收面

- 两个及以上并发事务争抢最后一个额度；
- multi-row / bulk insert 的原子 requested delta；
- 事务内 create → delete、失败 rollback、nested event 对 usage 的影响；
- Owner / database admin 不能通过普通 DDL 或数据写绕过平台策略；
- `DEFINE/ALTER/REMOVE` 配额的权限矩阵；
- 现有真实 table / field / record 扫描与旧计数漂移对账；
- 新 workspace 创建中策略下发失败的补偿和重试；
- 套餐升级 / 降级 / 取消 / 过期事件幂等；
- fork 版本能力不匹配时拒绝启动还是降级服务；
- 原生错误经过 RPC 和 `surrealdb-js` 后结构不丢失；
- web runtime 把各资源超限映射为稳定领域结果；
- 旧事件移除后不会留下双计数或重复拒绝；
- 大量 workspace 下策略调和不会复用当前全量串行、启动 fail-fast 成为不可接受的启动瓶颈。

## 9. 给后续决策票的事实输入

- 当前唯一可执行的“套餐变更”是 root 手工改 workspace 内记录；没有商业订阅域。
- 当前 Plus 是 workspace 模板默认值，不是 checkout 或 entitlement 的结果。
- workspace 与 database 一一对应，`db_name` 是最直接的原生 database quota scope key。
- 浏览器管理员确实持有 database Owner 并能执行任意 SurrealQL；这是原生授权模型必须正面处理的事实。
- 当前表 / 字段 / 记录用量是业务元数据计数，迁移 bootstrap 必须以引擎实际资源为准，旧计数只可用于对账。
- 当前 root 生命周期和迁移框架可承载策略下发，但没有 policy revision、entitlement revision、quota reconciliation 或部分失败状态。
- 现有错误 UI 只懂权限 / not found / 网络等通用类别，配额尚无领域错误。
- 当前真实 CLI 测试证明事件方案的正常临界路径有效，不证明它是不可篡改计费边界。
