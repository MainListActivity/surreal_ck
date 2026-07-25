Status: done
Label: done
Assignee: /root

# 选择原生策略与用量账本的数据模型

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

原生配额策略与用量应存在哪个受保护的 catalog/KV 作用域，如何表达 database 默认值、table override、无限额和版本？用量是同步精确 counter、可重建派生状态还是混合模型；表/记录删除、数据库删除、恢复、导入和离线维护后如何保持或重建一致；这些元数据如何避免被目标 database 的 Owner 访问或篡改？

## Dependencies

- Blocked by: [`摸清 SurrealQL 资源定义与权限扩展面`](01-surrealql-resource-definition-extension.md)、[`摸清 SurrealDB 写路径与事务内计量扩展面`](02-surrealdb-transactional-enforcement-extension.md)、[`锁定首期可计费资源与口径`](04-billable-resource-taxonomy.md)、[`确定配额策略的作用域、继承与管理权限`](05-policy-scope-inheritance-authority.md)
- Blocks: [`定义事务内配额消费、释放与批量写语义`](07-transactional-consumption-semantics.md)、[`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)

## Comments

### 2026-07-24 — 已确认的存储边界

- 原生配额采用双模型：database KV 前缀下的受保护 `QuotaPolicyDefinition` 与独立内部 `QuotaUsage` key。
- `QuotaPolicyDefinition` 是 database-scoped、可版本化的 catalog definition；`QuotaUsage` 是按资源、规则和目标表拆分的事务热状态。两者不属于普通 SurrealQL table，不能被目标 database 的 DML/DDL 直接访问或修改。
- 策略只通过带父层 IAM 校验的原生 quota DDL 修改，通过带 system IAM `View` 校验的原生 INFO 接口读取；用量只能由引擎事务内 quota facade 修改。
- 两类 key 均归属目标 database 的内部前缀，随 database 生命周期清理，但策略定义与高频计数器分离，避免记录写入反复重写 catalog definition 或使策略缓存失效。
- surreal_ck `_system` 只保存控制面的期望态，不能充当原生策略或事务用量账本；workspace 普通表与 `DatabaseDefinition` 内嵌 counter 均不采用。

### 2026-07-24 — 已确认的策略快照模型

- 每个 database 只有一份当前生效的不可变 `QuotaPolicyDefinition` 快照；任何规则定义、修改或删除都先生成并验证完整新快照，再在一个事务中原子替换，读者不会看到新旧规则混合。
- 快照包含引擎内部 `format_revision`、引擎分配的单调递增 `generation`，以及具有稳定唯一 `rule_id` 的规则集合；`rule_id` 由管理控制面指定，不使用数组位置表达身份。
- 每条规则固定包含 `resource`（table/field/record）、`selector`（精确表名或正则）与 `limit`（有限 `u64` 或显式 `unlimited`）。显式 `unlimited` 与没有规则命中不同，并可作为 field/record 精确规则覆盖正则限额。
- 策略写入支持基于 `expected_generation` 的乐观并发保护，供 surreal_ck 调和器和运营面板避免覆盖并发人工修改。
- `format_revision` 只承担 fork 的序列化兼容；`generation` 才是策略变化、读回校验和用量关联使用的业务代数。即使外部语法修改单条规则，内部仍原子替换整份快照。

### 2026-07-24 — 已确认的混合账本

- 正常运行时，持久化 `QuotaUsage` counter 是配额准入的精确权威，必须与对应资源 mutation 在同一事务和 savepoint 中同步增减，不能用最终一致统计做硬限制。
- 从恢复语义看，counter 是可由 table/field catalog 与实际逻辑 record key 扫描重建的派生状态；引擎必须提供校验与重建路径，不能把 counter 当作不可恢复的唯一事实。
- table 用量按 `policy_generation + rule_id` 维护共享 `TableBucketUsage`，因为一个 table 会同时占用全部命中规则的计数桶。
- field 与 record 用量按物理 `table_name` 分别维护实际 `FieldUsage` 与 `RecordUsage`，不绑定策略规则或套餐；策略变化只重新解析有效限额，不重写这些实际用量。
- INFO 将当前策略快照与账本合成规则、实际用量、有效限额和剩余额度。首期不把逐次消费事件作为权威账本；审计事件可以独立存在，但不能参与准入正确性。

### 2026-07-24 — 已确认的持续计量

- database 没有配额策略时，table/field/record 仍持续维护基础用量账本，但所有资源不限额；删除策略只解除限制，不删除用量。
- 新 database 从空的 `QuotaUsageMeta(state=ready, epoch=1)` 开始。field/record 的每表 counter 始终随实际 mutation 更新；table catalog 始终是表存在事实。
- 后续首次分配或重新分配策略时，field/record 直接复用现有实际 counter，只为新策略 `generation` 从当前 table catalog 初始化 table 规则桶，无需扫描全部 records。
- 普通 SurrealQL import 不携带内部账本，但导入语句在目标 database 正常产生用量 mutation；运营控制面因此也能在订阅前读取真实用量并预演套餐变化。
- 接受无策略 database 也承担 counter 写放大的代价，以换取动态订阅时即时、精确且不可绕过的策略激活。升级前已有 database 需要一次受控账本回填。

### 2026-07-24 — 已确认的回填与重建协议

- `QuotaUsageMeta` 使用持久化 `uninitialized → rebuilding → ready` 状态，并保留失败后的 `corrupt` 状态；任何准入只信任 `ready` 的 active epoch。
- 首期回填/重建取得 database 级 quota maintenance fence。`rebuilding` 或 `corrupt` 期间 database 只允许读取与 INFO，拒绝写事务；不尝试在扫描期间实现 mutation 双写或追赶日志。
- 重建从一致性快照扫描 table/field catalog 与逻辑 record key，将结果写入新的 staged epoch；完整校验成功后原子切换 `active_epoch` 并进入 `ready`，旧 epoch 异步清理。
- 状态与 epoch 都持久化。进程在扫描期间崩溃时，重启后仍保持只读并重新开始或恢复重建，不能因为内存锁丢失而开放写入。
- 该方案接受已有大库迁移和灾难修复期间的只读窗口，以换取首期协议可验证、无扫描竞态；在线重建、双写与 catch-up 明确后置。

### 2026-07-24 — 已确认的删除结算

- counter 只跟随实际存在状态转换：record key、显式 field definition 或 table definition 由存在变为不存在时才释放 1；删除不存在目标、`IF EXISTS` 空操作和定义覆写不释放。
- `REMOVE TABLE`/`EXPUNGE` 使用专用事务结算：删除 catalog 与数据前缀、直接删除该表的 `FieldUsage`/`RecordUsage`，并将所有命中当前 table 规则的 `TableBucketUsage` 各减 1；不按表内 records 逐条扫描或递减。
- 删除超额资源始终允许，因为它减少用量；但账本处于 `rebuilding`/`corrupt` 时仍执行 database 级只读屏障。
- 同名 table 删除后重建是新的资源存在周期，重新占用 table bucket，field/record 从 0 开始。删除整个 database 时，策略、usage meta、所有 epoch 和 counters 随 database 内部前缀一起删除。

### 2026-07-24 — 已确认的导入、恢复与离线维护边界

- 普通 SurrealQL import、SDK bulk write 与 DDL/DML replay 属于受信任语义路径：保留目标 database 当前策略、不导入源策略或 counter，并由实际 mutation 正常更新目标账本。
- 原始 KV snapshot restore、database 前缀复制、离线修复和任何绕过 quota facade 的写入均不可信任已有 counter。操作必须先取得 maintenance fence、把账本置为 `uninitialized/rebuilding`，数据安装后重建新 epoch；成功前保持只读。
- 普通 restore/clone 不恢复源策略：目标已有策略保持，新 database 默认无策略，之后由 surreal_ck 根据 `_system` 期望态重新物化。
- 只有 root/namespace Owner 的独立 quota-aware restore 可以恢复策略；即使使用该入口，用量仍从恢复后的实际数据重建，不直接信任备份 counter。
- 不能持久化 dirty 状态并触发重建的离线工具不受支持，使用后不能宣称原生配额仍可靠。

### 2026-07-24 — 已确认的历史归属

- SurrealDB 内核只保留当前 active `QuotaPolicyDefinition` 与 active usage epoch；新 generation/epoch 生效后，旧 table bucket 与旧 usage epoch 延迟清理，不永久保存完整历史快照。
- `generation` 只承担乐观并发、读回校验和状态关联，不是历史记录主键。
- 策略定义、修改、移除以及账本回填、重建失败和修复产生结构化审计事件；事件至少关联 database、旧/新 generation、策略摘要、操作者与时间，具体可观测契约由后续票确定。
- 套餐历史、人工 override、变更原因和账单解释由 surreal_ck `_system` 控制面持久化；数据库内核只负责当前硬限制。

### 2026-07-24 — Resolution

原生配额采用 database 内部前缀下的双模型：一份原子、可版本化的 `QuotaPolicyDefinition` 当前快照，以及与普通 table 隔离的事务 `QuotaUsage`。策略通过稳定 `rule_id`、table/field/record 资源类型、精确/正则 selector 和有限/显式无限 limit 表达；`.*` 规则表示 database 默认，field/record 的精确规则表示 table override，table 继续遵守全部匹配桶同时生效。`format_revision` 负责序列化兼容，单调 `generation` 负责并发与调和。

用量是“在线精确、离线可重建”的混合账本：table 按策略 generation/rule 维护共享桶，field/record 按物理表维护实际 counter；即使没有策略也持续计量但不限额。`QuotaUsageMeta` 通过持久化 state 与 epoch 管理回填和修复，首期重建期间 database 只读，扫描完成后原子切换 active epoch。

单项删除只按真实存在状态转换释放；整表删除直接清除该表用量并结算 table buckets，不逐记录扫描。语义 import 由实际 mutation 更新目标账本；原始恢复或离线写入必须标脏并重建。普通克隆/恢复不携带源策略，配额恢复属于 root/namespace Owner 的独立入口。内核只保留当前策略和用量，长期历史归 surreal_ck 控制面。
