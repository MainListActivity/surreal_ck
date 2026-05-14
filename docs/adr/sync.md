# ADR: remote 权威写侧与本地结构影子库 / 投影数据区架构

- **Status**: Accepted
- **Date**: 2026-05-12
- **Scope**: `src/main/db`、`src/main/sync`、`src/main/services`、`schema/main.surql`、资源检索/RAG、动态表 DDL 与本地投影恢复

## Context

应用同时使用两个 SurrealDB 实例：

- **本地（localdb）**：`@surrealdb/node` embedded，承担桌面端低延迟读取、RAG 检索和设备私有状态。
- **远端（remote）**：SurrealDB Cloud，OIDC JWT 鉴权，承担多设备/多成员共享真相。

上一版同步 ADR 假定：

- record user 可以对远端执行 `SHOW CHANGES FOR TABLE ...`
- record user 可以用 `INFO FOR DB` 枚举远端动态表
- remote→local 可以靠 changefeed cursor、补偿查询和 tombstone 协议保证收敛

这个前提已经被实测推翻：

- record user 对共享业务表执行普通 `SELECT` 可用
- `LIVE SELECT` 可用
- `SHOW CHANGES FOR TABLE ...` 会被远端 IAM 拒绝
- `INFO FOR DB` 这类管理向 introspection 也不能作为 remote 同步依赖

因此，原先基于 remote changefeed replay 的设计不能成立。

同时，产品已经明确分成两类共享数据：

1. **协作热数据**：`workspace / workbook / sheet / edge_catalog` 及 `ent_* / rel_*` 等工作簿主数据，要求 remote 为唯一权威写侧。
2. **共享资源库**：`resource_item / resource_embedding`，也属于共享真相，但读取更偏本地 RAG 和检索投影。

另有一类明确不共享的本地私有数据：

- `research_session`
- token / app meta / Mastra memory / observability
- 含 secret 的本地设置

这个 ADR 需要回答：

1. 共享真相放在哪一侧
2. 本地还保留什么，哪些是影子，哪些是投影
3. remote→local 在没有 `SHOW CHANGES` 的前提下如何收敛
4. 动态表和 embedding profile 如何在现有 IAM 约束下落地
5. 离线时哪些能力还能写，哪些必须停

## Decision

### 1. 拓扑

- **remote 是所有共享状态的唯一权威写侧**
- **local 不是第二真相，而是派生状态**

本地状态分成三层：

1. **结构影子库**
   - 保存 remote 共享结构元数据的本地 shadow
   - 主要包括：`workspace`、`app_user`、`has_workspace_member`、`pending_workspace_member`、`workbook`、`folder`、`sheet`、`edge_catalog` 以及其他需要本地解释动态表结构的共享元数据

2. **投影数据区**
   - 保存本地读取、查询、RAG、低延迟 UI 所需的共享数据投影
   - 主要包括：`ent_*`、`rel_*`、`resource_item`、`resource_embedding` 以及其他需要本地查询的共享读模型

3. **本地私有区**
   - 只属于当前设备/当前用户，不进入共享同步
   - 包括：`research_session`、token、`app_meta`、Mastra memory、observability、含 secret 的设置等

除本地私有区外，**结构影子库和投影数据区都定义为可丢弃、可重建的派生状态**。

### 2. 共享写模型

共享写操作统一采用 **remote-first** 语义。

#### 2.1 remote-first 的共享写范围

- 结构元数据：`workspace / workbook / sheet / edge_catalog`
- 工作簿主数据：`ent_* / rel_*`
- 共享资源库：`resource_item / resource_embedding`
- 工作区级 embedding canonical profile
- 其他共享固定表，默认沿用 remote-first，除非显式声明为本地私有

#### 2.2 local-only 的写范围

- `research_session`
- 其他设备私有数据

#### 2.3 self-write 可见性

对 remote-first 的共享写：

- **remote 写成功后**，同一个 RPC 内同步更新本地结构影子库或投影数据区
- **remote 写失败时**，本地不落共享业务变更
- **remote 成功但本地 apply 失败时**，RPC 返回错误，并把本地标记成需要修复/重建的 dirty projection 状态

高层读路径始终优先读本地，不做“同类数据有时读 remote、有时读 local”的混合语义。

### 3. 本地高层读模型

以下高层读路径统一读本地结构影子库和投影数据区：

- 编辑器、引用预览、动态表 schema 读取
- 仪表盘查询、AI 上下文快照
- 共享资源库详情、关键词检索、向量检索

remote 在读路径上的职责只有两个：

1. 共享写的权威提交点
2. 本地重建和增量回放来源

### 4. remote→local 收敛模型

放弃以下机制：

- remote `SHOW CHANGES`
- remote cursor
- 补偿 `SELECT ... WHERE updated_at > cursor`
- tombstone 协议

改成两段式：

#### 4.1 启动 / 重连 / 唤醒：全量重建

在以下时机，对结构影子库和投影数据区执行重建：

- 应用启动
- 远端连接恢复
- 机器唤醒或长时间挂起后恢复
- 本地被标记为 dirty projection
- 手动触发重建

重建语义：

- 清空对应本地派生状态
- 从 remote 按表全量 `SELECT *`
- 先恢复结构影子库，再按结构元数据恢复投影数据区

#### 4.2 在线稳态：只靠 `LIVE SELECT`

重建完成并在线后：

- 对固定共享表建立 `LIVE SELECT`
- 对动态表集合建立 `LIVE SELECT`
- 增量 create / update / delete 仅靠 `LIVE` 推送驱动本地 apply

如果 `LIVE` 断开、订阅集失配或本地状态可疑，不做 cursor 补偿，而是直接回到 **全量重建**。

### 5. 动态结构真相与动态表枚举

动态结构的权威真相不在 DDL introspection，而在共享业务元数据。

#### 5.1 `ent_*`

- 权威定义：`sheet.table_name + sheet.column_defs`
- 本地 `ent_*` DDL 仅由这份 metadata 派生

#### 5.2 `rel_*`

- 权威定义：`edge_catalog.rel_table + edge_props + from_table + to_table`
- 本地 `rel_*` DDL 仅由这份 metadata 派生

#### 5.3 remote 动态表枚举

remote 侧**永远不再使用** `INFO FOR DB` 枚举动态表。

动态表集合正式定义为：

- `ent_*` 集合 = 当前用户可见 `sheet.table_name`
- `rel_*` 集合 = 当前用户可见 `edge_catalog.rel_table`

#### 5.4 订阅集热更新

`sheet` 或 `edge_catalog` 的 `LIVE` 事件改变动态表注册表时：

- **新增表**：对该表做一次单表全量拉取，然后开始 `LIVE`
- **移除表**：停止该表 `LIVE`，并清掉本地对应投影
- **未变化表**：保留现有订阅，不做全局重建

### 6. 结构变更与 DDL

共享结构变更一律 remote-first。

- 远端 DDL 继续走 `execTemplate`
- 本地动态表 DDL 不是独立真相，只是 metadata 的派生执行结果

因此：

- `createSheet`
- `createWorkbookFromTemplate`
- `updateSheetFields`
- 动态关系类型创建/变更

都必须先让 remote 结构真相成立，再在同 RPC 内更新本地结构影子库和本地派生 DDL。

### 7. 共享资源库

#### 7.1 共享与私有边界

- `research_session` 是本地私有检索过程，不进入 remote 共享
- `saveResearchResource` 是一次**发布到共享资源库**的动作
- remote 共享 `resource_item` 载荷不再携带本地 `research_session` 引用
- 检索过程关联、发布状态、发布失败原因等仅对当前设备有意义的伴随信息，保留在本地私有区

#### 7.2 `resource_item`

- `resource_item` 是 remote-first 的共享资源主数据
- 本地创建时预分配最终 ID，remote 和 local 共用同一 ID
- 当前版本保留“允许重复”语义，不基于 duplicate hash 做跨设备自动去重
- 第一版不提供通用内容编辑 API；共享资源库只定义发布和弃用两类主路径

第一版共享资源库不做物理删除，走：

- 创建
- 查询
- 标记 `quality = "deprecated"`

即共享资源库采用 **append + deprecate** 语义。

#### 7.3 `resource_embedding`

- `resource_embedding` 是 remote-first 的共享索引资产
- 本地保留它的投影，用于 RAG、检索和低延迟读取

资源发布时，如果工作区已经配置 canonical embedding profile：

- 同一次 remote 写操作里，立即对 `(resource, profile_key)` UPSERT 一条 `resource_embedding(status="pending")`
- 同一个 RPC 内同步更新本地 `resource_embedding` 投影

共享状态机统一为：

- `disabled`：工作区尚未配置 canonical embedding profile
- `pending`：工作区已定义 profile，但该资源的当前 profile 向量还未完成
- `indexed`：向量已生成
- `failed`：共享索引失败
- `stale`：旧 profile 下的过期向量

`failed` 只保留安全的粗粒度状态和可公开的短摘要；原始 provider 错误、credential 细节和本地调试信息不进入共享表。

### 8. 工作区级 canonical embedding profile

不复用 `app_setting`。

新增专用 remote 表：`workspace_embedding_profile`。

原因：

- `app_setting` 当前主键和唯一索引只按 `key`，无法表达“一工作区一份 canonical profile”
- `app_setting` 也不适合承载这个级别的权限和约束

`workspace_embedding_profile` 的共享字段包括：

- `provider`
- `model`
- `dimensions`
- `version`
- `baseUrl`
- `apiFormat`

权限：

- **读**：工作区成员可读
- **写**：先做 workspace owner only

secret 不放进这张表：

- API key / credential 仍然是用户私有能力
- 共享的是向量空间定义，不是执行者凭据

### 9. profile 变更与索引重建

canonical profile 变更采用 **立即生效 + 异步重建**：

1. 新 profile 立即成为当前工作区唯一有效的向量空间
2. 旧 `resource_embedding` 统一标记为 `stale`
3. 对该工作区下所有 `resource_item`，按新的 `profile_key` 批量 UPSERT `resource_embedding(status="pending")`
4. 志愿索引器逐步把它们推进到 `indexed` 或 `failed`

检索期间允许退化：

- 没有 query embedding 能力的成员只能做关键词检索
- 尚未重建完成时，向量检索可临时处于 `pending / error / keyword-only`

### 10. 志愿索引器模型

第一版不引入独立后端索引服务。

任何在线成员客户端，只要：

- 持有私有 credential
- 并且配置与当前工作区 canonical profile 兼容

就可以作为志愿索引器，把 `pending` 的共享 `resource_embedding` 推进到 `indexed` 或 `failed`。

第一版不做分布式租约/claim：

- 允许多个客户端偶发同时处理同一条 `pending`
- 依靠 `(resource, profile_key)` 的稳定 ID 和 UPSERT 幂等收敛
- 代价是偶发重复调用 embedding API，但不破坏正确性

待索引恢复靠客户端周期性和事件性 sweep：

- 启动
- 重连
- profile 变更后
- 发布资源后
- 定期扫描 remote `pending`

### 11. 离线能力矩阵

离线时，不再使用单一“全局 readOnly”语义，而是按能力矩阵区分：

- `research_session`：**本地可写**
- `ent_* / rel_*`：**offline 禁写**
- `resource_item / resource_embedding`：**offline 禁写**
- `workspace / workbook / sheet / edge_catalog` 及其他共享结构元数据：**offline 禁写**
- 远端 DDL / schema 编辑：**offline 禁写**

因此，离线时唯一还能继续产生新业务状态的共享相关领域，只剩**本地私有检索过程**。

### 12. 本地修复与恢复

本地结构影子库和投影数据区既然是派生状态，就不再尝试维护复杂的增量补偿协议。

修复主路径统一为：

- 标记 dirty
- 停止受影响订阅
- 执行全量重建
- 重新建立 `LIVE` 订阅

这适用于：

- `LIVE` 断开后的状态不确定
- 本地 apply 失败
- schema/metadata 漂移
- profile 全量切换后的索引重建

## Consequences

### 好处

- 直接绕开 record user 无法执行 `SHOW CHANGES` 和 remote introspection 的 IAM 限制
- 不再维护 remote cursor、补偿查询和 tombstone 协议，架构明显收敛
- shared write / local read model 的边界清楚
- 动态表结构真相回到业务 metadata，不再依赖 DDL introspection
- 共享资源库与本地检索过程的边界清楚
- 本地派生状态既然可重建，漂移修复和版本迁移会更简单

### 代价

- `ent_* / rel_* / resource_item` 等共享域离线不可写
- 启动、重连、唤醒后的重建会带来额外延迟和流量
- `resource_embedding` 依赖志愿索引器，第一版没有中心化索引服务
- 没有私有 credential 的成员无法做 query embedding，只能关键词检索
- 第一版允许偶发重复索引计算，用成本换实现简化

## Implementation Direction

1. 重写 `src/main/sync/`：
   - 删掉对 remote `SHOW CHANGES`、remote cursor、tombstone 的依赖
   - 改成“重建 + LIVE”模型
   - 公共 RPC 只暴露 `getSyncStatusV2`、`triggerSyncRebuild`、`reconnectRemote`
   - 同步健康只表达 remote 连通、结构影子库 dirty、投影数据区 dirty、重建中和最近重建时间
2. 为本地状态引入明确分层：
   - 结构影子库
   - 投影数据区
   - 本地私有区
3. 新增 `workspace_embedding_profile`，并把 embedding canonical profile 从用户本地设置中拆出来
4. 重写资源服务：
   - `research_session` 保持本地私有
   - `saveResearchResource` 直接发布到 remote 共享资源库
   - 资源发布时显式创建 remote `resource_embedding(status="pending")`
5. 把 `context` 从单一 `readOnly` 布尔值演进为能力矩阵
6. 把动态表重建和订阅集维护改成 metadata 驱动

## Rejected

以下方案在当前约束下被放弃：

- remote `SHOW CHANGES` + cursor 双向对称同步
- `updated_at` 补偿查询 + tombstone 协议
- remote `INFO FOR DB` 动态表枚举
- `resource_embedding` 继续绑定用户本地 profile，而不是 workspace canonical profile
- 共享资源库离线先写、本地待发布
