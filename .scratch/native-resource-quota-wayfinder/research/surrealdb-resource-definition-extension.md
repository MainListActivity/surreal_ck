# SurrealDB 原生配额资源定义扩展面研究

## 结论摘要

在当前 SurrealDB 源码中，一种“可定义、修改、移除、查询”的持久化资源不是只加一个 parser 分支；它会贯穿词法关键字、两层 AST、`ToSql` 往返、catalog 的 revisioned KV 值、专用 KV key 与 catalog provider、事务缓存、DDL compute、IAM `ResourceKind` / `Base`、两套 `INFO` 执行路径、database export/import，以及 parser、兼容性、key 编码、IAM 和端到端测试。

`SequenceDefinition` 是目前最适合复制其**机械结构**的参照：它是具名、database-scoped 的 catalog definition，已有 `DEFINE` / `ALTER` / `REMOVE`、专用 KV key、单项与集合 provider、事务缓存、`INFO FOR DATABASE`、export/import、状态清理和并发测试。证据链从 parser 到存储、查询和导出是完整的。

但 Sequence 不能作为配额的**授权语义**参照。它的三种 DDL 都用 `Action::Edit + ResourceKind::Sequence + Base::Db`，因此同 database 的 Owner 可以定义、修改和移除 Sequence。配额的前提恰是 workspace database Owner 不能篡改自己的限制。现有 `DatabaseDefinition` 生命周期用 `ResourceKind::Database + Base::Ns`，更接近“父层管理子 database”的授权 seam；而存储位置与 IAM `Base` 在代码上是两项独立选择，所以候选实现可以把策略存于 database 元数据前缀、同时在执行入口按 namespace 层级授权。本报告不决定最终作用域、语法或角色矩阵。

`ConfigDefinition`、`BucketDefinition`、`AccessDefinition` 和 `TableDefinition` 各有局部可借鉴之处，但直接照搬会分别引入 singleton/kind 作用域、database Owner 可管理、认证密钥语义或数据面 `PERMISSIONS` 语义。尤其不能把 table/bucket 的 `PERMISSIONS` 当成“谁能管理配额”；前者是内容/数据面的权限表达式，资源管理授权走的是 IAM。

## 研究范围与源码快照

- 仓库：`/Users/y/IdeaProjects/surrealdb`
- HEAD：`9d9a5b0693e499e0d030cac6b618062ec02cd2bc`
- 提交：`2026-07-02T07:28:03+01:00 chore(deps): bump revision to 0.30.0 (#534)`
- workspace 版本：`3.3.0-nightly`，Rust edition 2024（`Cargo.toml:31-36`）
- 研究日期：2026-07-24
- 第一手来源：该 HEAD 的 parser、AST、catalog、KVS、IAM、executor、export/import 与测试代码。
- 边界：只定位事实、完整扩展面与候选 seam；不决定原生配额的最终 SurrealQL、资源粒度、继承、用量算法或降级行为。

下文源码路径均以 `/Users/y/IdeaProjects/surrealdb` 为根。

## 1. 最完整的机械参照：SequenceDefinition

Sequence 的资源定义链路如下：

```text
keyword / lexer
  → DEFINE / ALTER / REMOVE parser
  → sql::* statement（格式化、公共/解析 AST）
  → expr::* statement（执行 AST）
  → Expr::{Define,Alter,Remove}
  → legacy compute
  → IAM check
  → revisioned SequenceDefinition
  → database/sq typed KV key
  → DatabaseProvider / Transaction lookup
  → transaction cache
  → INFO FOR DATABASE
  → database export → OPTION IMPORT → re-execute DEFINE
```

它适合作为结构参照，原因不是名字或功能相近，而是完整覆盖了本票要求的生命周期：

- `SequenceDefinition` 是物理存储的 revisioned catalog 类型，并实现 `KVValue`、`InfoStructure` 和 `ToSql`（`surrealdb/core/src/catalog/schema/sequence.rs:14-57`）。
- DEFINE 支持 default / `OVERWRITE` / `IF NOT EXISTS`，会校验表达式、写 definition、清理旧运行态并失效缓存（`surrealdb/core/src/expr/statements/define/sequence.rs:39-124`）。
- ALTER 会读取现有定义、支持 `IF EXISTS`、更新 definition 并失效缓存（`surrealdb/core/src/expr/statements/alter/sequence.rs:36-83`）。
- REMOVE 会读取定义、通知进程内 sequence coordinator、删除 batch/state 范围和 definition，并失效缓存（`surrealdb/core/src/expr/statements/remove/sequence.rs:30-73`）。
- 单项读取、集合读取、时间版本读取、`INFO FOR DATABASE` 和 export 均已接通，详见后文。

需要明确分开两类参照：

| 维度 | 首选参照 | 原因 |
|---|---|---|
| parser、AST、catalog、KV、cache、INFO、export 的机械骨架 | Sequence | 具名 database definition 的链路最完整 |
| “谁能管理某 database 的配额”授权边界 | Database lifecycle | DEFINE / ALTER / REMOVE DATABASE 在 namespace 层做 IAM 检查 |
| 同一种命令可落 Root / Namespace / Database 的路由 | Access | `self.base` 同时驱动 IAM 和三类 key，但认证语义不可复用 |
| 按 kind 映射不同 scope 的定义 | Config | `ConfigKind::base()` 可借鉴；当前没有 namespace config |

## 2. SurrealQL、AST 与执行分发扩展面

### 2.1 词法和 parser

如果最终设计增加新关键字，至少会触及：

- token keyword 枚举/字符串映射：`surrealdb/core/src/syn/token/keyword.rs:175-192`；
- reserved keyword 集合：`surrealdb/core/src/syn/lexer/keywords.rs:40-55`；
- 大小写无关的 lexer 映射：`surrealdb/core/src/syn/lexer/keywords.rs:245-258`。

把新词加入 reserved set 会改变同名裸 identifier 的解析行为，因此这不是纯内部变更，必须由最终语法票显式确认。

DEFINE、ALTER、REMOVE 是三条独立 parser 路径：

- DEFINE 的资源分派在 `surrealdb/core/src/syn/parser/stmt/define.rs:45-78`；Sequence 具体语法及默认值在同文件 `1531-1563`。
- ALTER 的资源分派和 Sequence parser 在 `surrealdb/core/src/syn/parser/stmt/alter.rs:22-46,1217-1239`。
- REMOVE 的资源分派和 Sequence parser 在 `surrealdb/core/src/syn/parser/stmt/remove.rs:19-47,262-274`。

所以即便最终三条语句共用一个资源名，也仍需分别接入三套 parser 和对应负向测试；不能假设 DEFINE 分支会自动覆盖 ALTER/REMOVE。

### 2.2 两层 AST 与 `ToSql`

当前 DDL 有两层表示：

1. `sql::statements::*`：parser 构造、`ToSql` 格式化以及与执行 AST 的双向转换；
2. `expr::statements::*`：执行期结构与 `compute()`。

Sequence 的 SQL 层定义及双向转换在 `surrealdb/core/src/sql/statements/define/sequence.rs:7-71`，并注册到：

- `surrealdb/core/src/sql/statements/define/mod.rs:67-159`
- `surrealdb/core/src/sql/statements/alter/mod.rs:79-170`
- `surrealdb/core/src/sql/statements/remove/mod.rs:38-129`

执行层则分别注册到：

- `surrealdb/core/src/expr/statements/define/mod.rs:81-130`
- `surrealdb/core/src/expr/statements/alter/mod.rs:108-165`
- `surrealdb/core/src/expr/statements/remove/mod.rs:48-97`

顶层表达式用 `Expr::Define` / `Expr::Remove` / `Expr::Alter` 承载 DDL（`surrealdb/core/src/expr/expression.rs:35-99`）；`read_only`、副作用检查与 compute dispatch 也按这些顶层变体处理（同文件 `101-156,416-447,500-540`）。增加一个资源通常不需要新增顶层 `Expr` 变体，但必须接入三个 statement enum、转换和 compute 分派。

若最终配额 statement 字段允许表达式，还需同步不可变/可变 visitor。Sequence 的 visitor 分支散布在 `surrealdb/core/src/expr/visit.rs:405,719,958-973,1976,2290,2529-2544`。遗漏 visitor 会让表达式遍历、改写或静态分析出现不完整行为。

`ToSql` 不是装饰输出。执行 `Expr` 的 revisioned 序列化会把表达式写成 SurrealQL 字符串，再通过 parser 反序列化（`surrealdb/core/src/expr/expression.rs:918-991`）。因此含 Expr 的持久化定义必须保证 parser / `ToSql` 稳定往返；通用格式化回归表位于 `surrealdb/core/src/sql/test_to_sql.rs:28-180`。

### 2.3 DDL 当前仍走 legacy compute

streaming planner 对 `Expr::Define`、`Remove`、`Rebuild`、`Alter` 明确返回 `PlannerUnsupported`（`surrealdb/core/src/exec/planner.rs:1229-1241`）；共享的 plan-or-compute 路径在遇到 `PlannerUnsupported` / `PlannerUnimplemented` 时回退到 `Expr::compute()`（`surrealdb/core/src/exec/plan_or_compute.rs:1-16,101-151`）。因此首版新资源 DDL 的真实执行 seam 是现有 statement `compute()`，而不是新增 physical operator。

但 `expr_required_context` 当前把所有 DEFINE / REMOVE / ALTER / REBUILD 保守判为 `ContextLevel::Database`（`surrealdb/core/src/exec/plan_or_compute.rs:348-362`）。若最终命令要在未选择 database 时执行，或由 namespace 管理员针对某个 database 执行，这里是需要重新审视的上下文 seam；本票不决定目标上下文模型。

## 3. revisioned catalog 与 KV 存储扩展面

### 3.1 catalog definition 是唯一物理定义

catalog 模块明确约束：“catalog should be the only structs/enums that are stored physically in the KV Store”（`surrealdb/core/src/catalog/mod.rs:1-7`）。所以原生配额若是持久化资源，其权威 definition 应进入 catalog，而不是直接把 parser AST 或任意业务 record 当作引擎元数据。

Sequence 的定义：

- `#[revisioned(revision = 1)]`；
- 字段使用稳定的存储类型；
- `impl_kv_value_revisioned!`；
- 提供 catalog definition → SQL definition、结构化 INFO、`ToSql`。

见 `surrealdb/core/src/catalog/schema/sequence.rs:14-57`。`impl_kv_value_revisioned!` 实际使用 `revision::to_vec` / `revision::from_slice`（`surrealdb/core/src/kvs/key.rs:80-117`）。

若定义后续增加字段，必须按 revisioned 的版本化字段规则演进；已有多版本字段例子可见 `surrealdb/core/src/catalog/schema/config.rs:80-95`。另外，IAM 的 `ResourceKind` 自身也是 revisioned enum；Sequence 是 revision 5 新增的变体（`surrealdb/core/src/iam/entities/resources/resource.rs:7-38`），说明新增 IAM resource 也必须遵循追加 revision/discriminant 兼容方式，而不只是改一个 match。

catalog 兼容测试不是可选旁路。`surrealdb/core/src/catalog/compat/README.md:1-63` 说明 frozen bytes、fixtures、generator、tests 的数据流，`167-172` 明确列出新增 catalog type 所需步骤。Sequence 的现成参照位于：

- fixtures：`surrealdb/core/src/catalog/compat/fixtures.rs:1130-1152`
- generator：`surrealdb/core/src/catalog/compat/generator.rs:457-474`
- decode tests：`surrealdb/core/src/catalog/compat/tests.rs:558-571`

### 3.2 typed key、分类与 provider

Sequence 的 typed key `Sq` 同时声明 key layout、值类型、集合前后缀和 diagnostics category（`surrealdb/core/src/key/database/sq.rs:1-58`）；同文件 `60-81` 固定验证单 key、prefix、suffix 的精确字节。对应 `Category::DatabaseSequence` 在 `surrealdb/core/src/key/category.rs:100-113,248-261`。

新增持久化资源因此至少需要：

- 明确 key 所在层级和稳定前缀；
- `KVKey` → catalog definition 的 typed 映射；
- prefix/suffix range，供集合读取、INFO 和 export 使用；
- key category 与编码单测；
- 在相应 `key/{root|namespace|database}` 模块中注册。

catalog provider 是上层读取边界。Sequence 在 `DatabaseProvider` 中同时暴露：

- 集合：`all_db_sequences`（`surrealdb/core/src/catalog/providers.rs:221-227`）；
- 单项：`get_db_sequence`（同文件 `288-294`）。

事务实现会区分带 version 的历史读与当前读：集合读取做 prefix range scan，当前版本才使用 `Lookup::Sqs` 缓存（`surrealdb/core/src/kvs/tx.rs:2587-2617`）；单项读取用 typed key，缺失时报 `SeqNotFound`，当前版本使用 `Lookup::Sq` 与 `Entry::Any`（同文件 `2858-2892`）。原生配额要进入 INFO / export 或支持历史 `INFO ... VERSION`，就不能只写入 KV 而不补 provider 的版本读路径。

### 3.3 transaction cache 与失效

Sequence 的集合/单项缓存键分别在：

- borrowed lookup：`surrealdb/core/src/kvs/cache/tx/lookup.rs:8-123`
- owned key：`surrealdb/core/src/kvs/cache/tx/key.rs:7-122`
- 集合 entry：`surrealdb/core/src/kvs/cache/tx/entry.rs:45-69,205-211`

`Lookup` 与 owned `Key` 还有等价比较和转换分支，不能只加 enum variant。DEFINE、ALTER、REMOVE Sequence 最终都调用 `txn.clear_cache()`（define `121-122`；alter `77-81`；remove `67-71`）。当前源码没有显示 Sequence definition 使用额外的 datastore 级 schema cache；其 catalog 读取主要依赖 transaction cache。本票只确认这一层，不推断未来用量计数是否也应缓存。

## 4. 生命周期 compute 与错误表面

一个新资源的三种操作需要独立处理以下语义：

| 操作 | Sequence 现有行为 | 配额资源需要显式回答但本票不决定的点 |
|---|---|---|
| DEFINE | IAM → 计算名/值 → duplicate 处理 → 写 definition → 清旧运行态 → clear cache | 是否具名；覆盖策略是否保留现有 usage；定义与用量是否同一事务 |
| ALTER | IAM → 读取 → `IF EXISTS` → 修改 → 写回 → clear cache | 降低 limit 时是否允许产生 over-limit；哪些字段可变 |
| REMOVE | IAM → 读取 → `IF EXISTS` → 清运行态/definition → clear cache | 移除代表无限额、继承父策略，还是禁止；是否保留 usage |

Sequence 的 duplicate / missing 错误有专用 `Error` variants，例如 `SeqAlreadyExists` 在 `surrealdb/core/src/err/mod.rs:917-921`，`SeqNotFound` 被 provider、ALTER 和 REMOVE 使用。配额后续若需要结构化超额错误，definition lifecycle 错误与 data-path enforcement 错误应被视为不同扩展面；具体错误契约留给后续票。

Sequence 还有 batch/state key 与进程内 coordinator，因此其 DEFINE/REMOVE 会额外清理运行态。这证明“definition metadata”和“runtime state”在 SurrealDB 内可以分开建模；但 sequence 的预分配算法不是 quota usage 的并发模型证据，不能机械移植。

## 5. IAM：最关键的不可照搬点

### 5.1 当前能力模型

当前 IAM action 只有 `View` 和 `Edit`，源码还留有未来 custom roles / policies 的 TODO（`surrealdb/core/src/iam/entities/action.rs:4-11`）。内置角色只有 Viewer / Editor / Owner。

授权判定在 `surrealdb/core/src/iam/mod.rs:71-98`：

- `View` 只检查 resource level 是否位于 actor level 之下；
- Owner 的 `Edit` 同样按 level 包含关系判断；
- Editor 的 `Edit` 还要求 `ResourceKind` 落在硬编码白名单；
- 当前白名单包含 `Database`，但不包含 `Sequence`、`Bucket`、`Config`、`Access`。

`Context::is_allowed` 把 `Base::Root` / `Ns` / `Db` 转成具体 `Resource` level（`surrealdb/core/src/ctx/context.rs:587-609`）；`Level::sublevel_of` 定义 root、同 namespace、同 database 的包含关系（`surrealdb/core/src/iam/entities/resources/level.rs:28-55`）。

### 5.2 Sequence 的授权为何错误

Sequence 的 DEFINE、ALTER、REMOVE 都使用：

```rust
Action::Edit, ResourceKind::Sequence, Base::Db
```

证据分别在：

- `surrealdb/core/src/expr/statements/define/sequence.rs:39-50`
- `surrealdb/core/src/expr/statements/alter/sequence.rs:36-47`
- `surrealdb/core/src/expr/statements/remove/sequence.rs:30-40`

结果是 database Owner 能管理同 database 的 Sequence。虽然 database Editor 因 Sequence 不在白名单而不能管理，但这无法阻止 surreal_ck 的 workspace admin，因为当前问题正来自其 database Owner 能力。

### 5.3 Database lifecycle 是更合适的父层授权 seam

DEFINE DATABASE 在 `Base::Ns` 检查 `ResourceKind::Database`（`surrealdb/core/src/expr/statements/define/database.rs:41-53`）；ALTER 和 REMOVE DATABASE 也采用相同组合（`surrealdb/core/src/expr/statements/alter/database.rs:18-33`，`surrealdb/core/src/expr/statements/remove/database.rs:31-43`）。

这提供了一个源码事实：**管理 database 子资源的 definition 可以在 namespace level 授权，而被管理对象仍是某个 database。** 同理，策略 definition 的 KV key 是否放在 database 前缀，并不强制其 IAM 必须使用 `Base::Db`。

但 `ResourceKind::Database` 在 Editor 白名单中，所以 namespace Editor 也能编辑 database。若后续要求只有 instance/namespace Owner 或特定平台主体能管理 quota，必须同时决定：

- 新资源是否使用独立 `ResourceKind`；
- 它是否进入 Editor 白名单；
- IAM 检查使用 Root、Namespace 还是 Database base；
- 是否需要超出当前 `View/Edit × Viewer/Editor/Owner` 模型的新 action/policy。

这些是后续作用域/权限票必须锁定的决策，本报告不代替该决策。

## 6. INFO 查询扩展面

### 6.1 database 聚合 INFO

当前 `InfoStatement` 只有 Root、Namespace、Database、Table、User、Index，没有单个 Sequence 目标（`surrealdb/core/src/sql/statements/info.rs:6-17`）。Sequence 通过 `INFO FOR DATABASE` 的 `sequences` 集合被查询。

INFO 存在两套都要更新的执行实现：

1. streaming operator：`surrealdb/core/src/exec/operators/info/database.rs:118-164,245-250`
2. legacy compute：`surrealdb/core/src/expr/statements/info.rs:173-206,287-293`

streaming planner 还会把每种 `InfoStatement` 映射为 operator（`surrealdb/core/src/exec/planner.rs:1373-1418`）。如果后续只把 quota 加进 `INFO FOR DATABASE`，无需增加 INFO parser variant，但两套 database output 和快照都要同步；如果要增加单独的 `INFO FOR QUOTA`，则还会触及：

- `InfoStatement` 的 SQL/expr 变体和双向转换；
- `surrealdb/core/src/syn/parser/stmt/mod.rs:417-470`；
- `plan_info_statement`；
- `info_stmt_required_context`（`surrealdb/core/src/exec/plan_or_compute.rs:390-406`）；
- 新 legacy/streaming 执行分支。

### 6.2 可见性与管理权是两件事

两套 `INFO FOR DATABASE` 都以 `Action::View + ResourceKind::Any + Base::Db` 授权（streaming：`exec/operators/info/database.rs:118-129`；legacy：`expr/statements/info.rs:173-179`）。结合 `Action::View` 只检查 level 的事实，把 quota 放入 database INFO 会使同 database 或更高层 actor 能看到它，不会沿用 DEFINE 的管理限制。

“tenant 能看 limit/usage 但不能改”与当前 IAM 结构是可以表达的；“某些字段仅平台可见”则不能仅靠把资源加入 database INFO 自动得到。最终 INFO 的可见字段和结构需在后续契约票决定。

## 7. export / import 扩展面及控制面冲突

database export 的 core `Config` 已把 Sequence 作为独立布尔选项，默认开启（`surrealdb/core/src/kvs/export.rs:20-55`）。metadata export：

1. 先输出 `OPTION IMPORT`；
2. 通过 provider 获取每类 definition；
3. 对每项调用 `ToSql` 并输出以分号结束的 DDL。

Sequence 的具体分支在 `surrealdb/core/src/kvs/export.rs:183-191,264-296`。这说明 database-local quota 若进入默认备份，必须具备稳定的 catalog → `ToSql` → parser → DEFINE 往返。

导入不是专用反序列化器，而是执行 SurrealQL。`OPTION IMPORT` 自身要求 `Action::Edit + ResourceKind::Option + Base::Db`，然后设置 `opt.import`（`surrealdb/core/src/dbs/executor.rs:191-206`）；Sequence DEFINE 在 `opt.import` 时允许 default definition 覆盖已存在项（`expr/statements/define/sequence.rs:63-77`）。

这里有一个必须留给后续票的安全/产品决策：

- 若 quota definition 使用 namespace-level 管理授权，database Owner 即便可以运行 `OPTION IMPORT`，执行备份中的 quota DDL 时仍会因 namespace-level IAM 失败；
- 若为了 tenant 自助恢复而把 quota DDL 放宽到 database-level，又重新打开了 tenant 修改自己配额的漏洞；
- 因此“配额是否属于 tenant database backup”不能由“它存在哪个 KV 前缀”被动决定，必须明确选择排除、只读导出、由控制面单独恢复，或要求更高权限恢复。

此外，公共 Rust SDK 的 selective export builder 当前有 users/accesses/params/functions/analyzers/tables/records/apis/buckets/modules/configs 方法，却没有与 core `Config.sequences` 对应的方法（`surrealdb/src/method/export.rs:64-178`）。这说明实现新资源时应同时审计 core export 配置、公开 SDK builder、HTTP/RPC 配置映射和测试，不能把现有 Sequence 的 public surface 当作完整模板。

## 8. 容易误导的相似资源

### 8.1 ConfigDefinition

`ConfigInner` 按 kind 映射 `ConfigKind::base()`，然后选择 root 或 database key；namespace 明确不支持（`surrealdb/core/src/expr/statements/define/config/mod.rs:20-41,61-135`）。当前 `Default` config 是 root-scoped，GraphQL/API 是 database-scoped（`surrealdb/core/src/iam/entities/resources/resource.rs:40-56`）。

可借鉴：kind → scope → key 的分派。

不可照搬：它更像每 kind 一个配置槽，而不是对多个 database/table/resource 建立策略；database config 仍由 database Owner 管理，且没有 namespace config 路径。

### 8.2 BucketDefinition

Bucket 是 database-scoped definition，具备 `PERMISSIONS`、INFO、KV 和 lifecycle；DEFINE 先做 `ResourceKind::Bucket + Base::Db` IAM，再验证 permission 表达式只读（`surrealdb/core/src/expr/statements/define/bucket.rs:38-57`）。catalog 中的 `Permission` 是 bucket 内容访问表达式（`surrealdb/core/src/catalog/schema/bucket.rs:18-28`）。

可借鉴：带数据面规则的 revisioned definition。

不可照搬：`PERMISSIONS` 不是管理 definition 的 capability。`Permission` / `Permissions` 表达的是 `select/create/update/delete` 数据操作（`surrealdb/core/src/catalog/schema/mod.rs:40-47,98-105`），不能阻止 database Owner ALTER/REMOVE quota。

### 8.3 AccessDefinition

Access DEFINE 用 `self.base` 做 IAM，并分别写 root、namespace、database key（`surrealdb/core/src/expr/statements/define/access.rs:350-469`）。

可借鉴：一个 statement 在多级 scope 下的路由方式。

不可照搬：Access 的 actor/认证、算法、密钥、redaction 和 grant 语义与资源治理无关；复用其资源种类或错误会把 quota 耦合到 IAM 凭据生命周期。

### 8.4 Table / Field

Table/Field 与 quota 的目标资源表面接近，也有丰富 `PERMISSIONS` 和 schema lifecycle，但它们是在 database 内由 DDL actor 管理的数据 schema。若配额沿用相同 `Base::Db` 管理边界，workspace database Owner 就能继续移除或扩大限制。它们适合作为后续 enforcement hook 的被计量对象，不适合作为 quota policy 的管理 authority。

### 8.5 直接扩展 DatabaseDefinition

DatabaseDefinition 本身由父 namespace 管理，授权边界接近需求；但把所有 quota 字段直接嵌入它，会把配额的版本、命名、继承、多个资源规则和独立 ALTER/REMOVE 生命周期绑定到 database definition 的 revisioned serialization。当前源码并不能证明这种耦合优于独立 catalog resource。它是一个候选 seam，不是本票结论。

## 9. 测试扩展清单

新增资源至少需要覆盖以下层次；括号内为现有 Sequence 或 DDL 参照：

| 层次 | 必测内容 | 当前参照 |
|---|---|---|
| lexer/parser | 大小写、默认值、IF EXISTS/IF NOT EXISTS/OVERWRITE、非法组合、参数化名称、keyword/identifier 回归 | `syn/parser/test/stmt.rs`；`language-tests/tests/language/statements/define/sequence/*`；`statements/remove/sequence.surql` |
| SQL 格式化 | parse → ToSql、执行 AST 双向转换、表达式括号/转义 | `sql/test_to_sql.rs` |
| catalog 兼容 | 新 definition frozen bytes；新增字段默认值与旧版本 decode | `catalog/compat/{README,fixtures,generator,tests}.rs` |
| KV key | 单项、prefix、suffix 精确字节；category | `key/database/sq.rs:60-81` |
| provider/cache | 单项/集合、缺失错误、带 version 读取、写后失效 | `kvs/tx.rs:2587-2617,2858-2892` |
| lifecycle | DEFINE/ALTER/REMOVE 的 duplicate/if-exists/import/rollback | `core/tests/{define,alter,remove}.rs` |
| IAM | root/ns/db × Viewer/Editor/Owner 的允许/拒绝矩阵，尤其 DB Owner 不可管理 | `core/tests/{define,alter,remove}.rs` 的通用 DDL 授权模式 |
| INFO | legacy 与 streaming、text 与 STRUCTURE、VERSION、空集合和 snapshots | `core/tests/info.rs`；空 database snapshot 在 `:290` 已含 sequences |
| export/import | 默认是否包含、selective config、ToSql 可重放、不同 actor 恢复结果 | `kvs/export.rs` 与 `tests/{cli,http}_integration.rs` |
| 并发/恢复 | definition 更新与 enforcement 同事务可见性、重启后 definition/usage 一致性 | `core/tests/sequence.rs:30-110` 只可借鉴测试形态，不可借鉴算法 |
| fuzz | 新 grammar 不 panic；格式化/执行 fuzz 字典更新 | `fuzz/fuzz_targets/{fuzz_sql_parser,fuzz_format,fuzz_executor}.rs` |

现有 `core/tests/sequence.rs:30-81` 验证并发 nextval，`84-110` 验证重启持久化。这是“新原生状态要有并发和恢复测试”的好参照，但不能替代 quota 在 CREATE/INSERT/DELETE 事务路径上的专门竞争测试。

## 10. 给后续决策票的源码约束

后续设计可以在以下已证实 seam 上做选择，但必须逐项明确：

1. **策略存储层级与管理 IAM base 可以分离。** database-local KV 有利于按 database 查找和运行时 enforcement；namespace/root `Base` 才决定谁能改。
2. **需要独立 `ResourceKind` 才能避免继承 Database/Table 的 Editor 白名单语义。** 是否还需新 Action 或 custom policy，取决于最终管理主体。
3. **tenant 可见性需与管理权分开设计。** 加入 `INFO FOR DATABASE` 会自然给 database-level viewer 暴露相应输出。
4. **database backup 不能默认决定控制面策略的所有权。** namespace-only 管理与 tenant 自助 import 存在真实授权冲突。
5. **parser / `ToSql` 是持久化兼容面。** 含 Expr 的 definition 和 export 脚本都依赖可重放的 SurrealQL。
6. **definition 与 usage/enforcement 是不同状态。** 本票定位的是 definition lifecycle；用量计数、事务原子性、批量写入和删除释放需要在 enforcement 研究中单独确定。
7. **首版不必新增 streaming DDL operator。** 当前 DDL 有明确 legacy fallback；但 INFO 已有 streaming operator，必须双路更新。

最终的实现清单不能只写“仿照 Sequence”。准确表述应是：

> 用 Sequence 复制资源定义的机械链路；用 Database lifecycle 校准父层授权；用 Access/Config 仅参考多 scope 路由；明确拒绝复用 database-scoped Owner 管理与数据面 PERMISSIONS 作为配额控制面。
