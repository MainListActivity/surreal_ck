# SurrealDB 写路径与事务内配额强制扩展面

## 结论摘要

当前源码没有一个现成函数能同时覆盖“所有表创建 / 删除”和“所有逻辑记录创建 / 删除”。语句层、planner 和 `Document` 层都不是完整的无旁路强制面：

- 常规 SurrealQL `CREATE`、`INSERT`、`UPSERT`、`RELATE`、`DELETE`，包括数组批量、SQL import 和 GQL mutation，最终会复用 `Document` 管线；
- 但物化 / 聚合视图维护与初始化存在直接事务级记录写入，不都经过 `Document::store_record_data` / `purge_record_data`；
- `REMOVE TABLE` 通过事务内前缀删除清空整表，不逐条调用 `del_record`；
- 非 strict database 中，DML 还可以通过 `get_or_add_tb` 隐式创建 table，不能只拦截 `DEFINE TABLE`。

因此，当前源码下最小的**完整候选扩展面是一个组合 seam**，而不是单点 hook：

1. table catalog 的“从不存在到存在 / 从存在到不存在”转换面，覆盖显式 `DEFINE/REMOVE TABLE` 与 `get_or_add_tb` 隐式建表；
2. transaction 层有语义的 `RecordKey` 新建、覆盖、删除面，并把当前物化视图的直接 `tx.put/set/del` 收敛进去；
3. `REMOVE TABLE` 等前缀 / 范围删除生命周期面，用于处理没有逐条记录事件的整表释放。

若计费资源是物理存储字节而不是逻辑 table / record，上述 seam 仍不够：索引、图指针、changefeed 等物理 KV 也占空间，必须另行覆盖通用 KV mutation；本报告不决定其口径或账本算法。

事务原子性基础已经存在：普通写语句、显式 `BEGIN ... COMMIT/CANCEL`、以及 `INSERT` / `UPSERT` 的 create-to-update 重试 savepoint 都使用同一个 `Transaction`。只要用量变更和资源变更都写入该 transaction，它们会一起提交、取消或回滚到 savepoint。并发“不超卖”则不能仅由“同事务”推出：Memory、RocksDB、SurrealKV 的现有测试证明同 key 并发盲写会冲突，TiKV 的现有测试明确允许这种 blind last-write-wins；IndexedDB 在本仓源码中没有同类并发证明。因此后续设计必须使用各支持 backend 都能观察到的竞争 / 条件更新语义，并补齐 backend 一致性测试，不能依赖 `count()` 扫描或普通共享 key `set`。

本报告只给出源码事实、旁路与候选 seam，不选择配额账本、预留算法、资源口径或重试策略。

## 研究范围与源码快照

- 仓库：`/Users/y/IdeaProjects/surrealdb`
- 分支：`main`
- HEAD：`9d9a5b0693e499e0d030cac6b618062ec02cd2bc`
- workspace 版本：`3.3.0-nightly`
- 审计日期：2026-07-24
- 主要范围：`surrealdb/core/src/{expr,dbs,doc,exec,kvs,key}` 与当前 backend 共用测试。

## 1. 写事务的外层边界

单条顶层计划先根据 `plan.read_only()` 选择读 / 写事务；写事务当前统一以 `LockType::Optimistic` 打开。执行成功后由 executor 提交，执行错误、非法控制流或超时时取消事务（[`executor.rs`](../../../../surrealdb/surrealdb/core/src/dbs/executor.rs#L1012-L1083)）。

显式事务块同样只创建一个 write transaction，块内语句共享它：

- `CANCEL` 调用 `txn.cancel()`，并把块内结果标成 cancelled；
- `COMMIT` 只在 `txn.commit()` 成功后保留结果；
- 任一块内语句失败会取消 transaction，后续语句直到 `COMMIT/CANCEL` 都标为未执行；
- 缺失 `COMMIT/CANCEL` 的事务块最终也会取消。

对应控制流见 [`executor.rs`](../../../../surrealdb/surrealdb/core/src/dbs/executor.rs#L1091-L1120)、[`executor.rs`](../../../../surrealdb/surrealdb/core/src/dbs/executor.rs#L1399-L1465)、[`executor.rs`](../../../../surrealdb/surrealdb/core/src/dbs/executor.rs#L1574-L1605) 和 [`executor.rs`](../../../../surrealdb/surrealdb/core/src/dbs/executor.rs#L1665-L1688)。`Transaction::cancel` 的契约是反转该 transaction 的全部变更，`commit` 才把底层 transaction 变为已提交状态（[`tx.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tx.rs#L1043-L1100)）。

这给原生配额提供了必要但不充分的基础：

- 必要：政策 / 用量 mutation 必须经 `ctx.tx()`，不能写进进程内计数器或独立 transaction；
- 不充分：两个 snapshot transaction 各自看到“尚有一个名额”，随后写不同资源 key，仍可能形成 write skew。是否冲突取决于它们是否共同竞争一个 backend 能检测的事务资源。

## 2. 记录 DML 的实际调用链

### 2.1 统一的常规 Document 管线

`CreateStatement::compute` 为目标构造 iterator，逐个 `prepare`，最后执行 `iterator.output`（[`create.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/create.rs#L46-L107)）。`Iterator` 对写语句的最终分派是：

| Statement | Document 入口 |
|---|---|
| `CREATE` | `doc.create(...)` |
| `INSERT` | `doc.insert(...)` |
| `UPSERT` | `doc.upsert(...)` |
| `RELATE` | `doc.relate(...)` |
| `UPDATE` | `doc.update(...)` |
| `DELETE` | `doc.delete(...)` |

分派事实见 [`iterator.rs`](../../../../surrealdb/surrealdb/core/src/dbs/iterator.rs#L1238-L1260)。

这些路径的最终逻辑记录持久化集中在两处：

- `Document::store_record_data` 对真正新记录使用 create-only `put_record`：`INSERT` 初次尝试、`UPSERT` 初次尝试、`CREATE`、新 `RELATE`；对更新使用 `set_record`（[`store.rs`](../../../../surrealdb/surrealdb/core/src/doc/store.rs#L10-L144)）。
- `Document::purge_record_data` 对实际删除调用 `del_record`；关系记录还会删除四个图指针，并继续级联处理连接边与 reference 策略（[`purge.rs`](../../../../surrealdb/surrealdb/core/src/doc/purge.rs#L40-L74)）。

因此不能按 statement 名称直接把 `UPSERT` 或 `INSERT ... ON DUPLICATE KEY UPDATE` 全部算作新增：是否新增只在 create-only `put_record` 成功时确定。

### 2.2 INSERT、UPSERT 与 savepoint

`INSERT` 和 `UPSERT` 的“先创建，冲突后改为更新”不是两个独立事务，而是在当前 transaction 内使用 savepoint；transaction wrapper 将 new / release / rollback 统一委托给 backend 实现（[`tx.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tx.rs#L1822-L1844)）：

1. 创建 savepoint；
2. 尝试 create；
3. 成功则 release；
4. 已存在或可重试错误则 rollback 到 savepoint，再进入 update；
5. 其他错误同样 rollback。

证据分别见 [`doc/insert.rs`](../../../../surrealdb/surrealdb/core/src/doc/insert.rs#L15-L93) 和 [`doc/upsert.rs`](../../../../surrealdb/surrealdb/core/src/doc/upsert.rs#L15-L84)。因此任何“尝试新建时的配额消费”若未进入同一 savepoint，会在 create 失败、随后 update 成功时泄漏名额。

### 2.3 RELATE

`RELATE` 对 `from` / `to` 数组形成组合并向 iterator 注入 `Iterable::Relatable`；relation table 不存在时也会走 `get_or_add_tb`（[`relate.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/relate.rs#L64-L180)）。新 edge 的逻辑记录经 `put_record` 创建；同时还会写四个独立 graph pointer KV（[`edges.rs`](../../../../surrealdb/surrealdb/core/src/doc/edges.rs#L95-L132)）。

由此可区分两种口径：

- 逻辑 record 配额：一次成功 `RELATE` 是一个 edge record；
- 物理存储配额：还必须计算 graph pointer、索引等附属 key。

### 2.4 DELETE 与级联

普通 `DELETE` 的主记录经 `del_record` 删除。edge record 的图指针删除、普通 record 的连接边级联，以及 reference 的嵌套 `DELETE` / `UPDATE`，都在同一 transaction 中递归执行（[`purge.rs`](../../../../surrealdb/surrealdb/core/src/doc/purge.rs#L140-L231)、[`purge.rs`](../../../../surrealdb/surrealdb/core/src/doc/purge.rs#L350-L431)）。

这意味着只在顶层 `DeleteStatement` 入口释放一次会漏掉级联删除；按实际 `RecordKey` mutation 观察才能覆盖嵌套效果。

### 2.5 GQL mutation

GQL mutation executor 没有另造记录写管线，而是合成原生 `UpdateStatement`、`DeleteStatement`、`CreateStatement`、`RelateStatement`，再调用 `legacy_compute`（[`mutate.rs`](../../../../surrealdb/surrealdb/core/src/exec/operators/mutate.rs#L320-L381)、[`mutate.rs`](../../../../surrealdb/surrealdb/core/src/exec/operators/mutate.rs#L540-L590)）。因此当前 GQL mutation 被常规 Document seam 覆盖，但这不是把强制逻辑放在 GQL planner 的理由；它恰恰说明强制面应低于语言前端。

## 3. 批量与 import 不构成独立存储旁路

`INSERT` 的数组表达式会逐元素解析 record id、按需 `get_or_add_tb`，再逐条向 iterator `ingest`（[`insert.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/insert.rs#L139-L207)）。因此一条 bulk INSERT 仍产生多次实际记录 create / update 决策。

HTTP / SDK 的 streaming import 最终由 `Datastore::execute_import` 解析 SQL statement stream，再调用 `Executor::execute_stream(..., true, ...)`（[`ds.rs`](../../../../surrealdb/surrealdb/core/src/kvs/ds.rs#L3775-L3835)、[`ds.rs`](../../../../surrealdb/surrealdb/core/src/kvs/ds.rs#L4000-L4016)）。import mode 要求首句为 `OPTION IMPORT`，它会跳过 event、LIVE、field processing、view processing 和成功结果输出以提升性能，但导入的 `INSERT` / DDL 仍由同一 executor 事务机制执行；每条普通 statement 或显式事务块继续遵循第 1 节的提交 / 回滚边界（[`executor.rs`](../../../../surrealdb/surrealdb/core/src/dbs/executor.rs#L1835-L1867)）。

所以：

- 应用级 `DEFINE EVENT` 会被 import mode 绕过；
- 引擎 transaction / record mutation seam 不会因 import mode 消失；
- 一次 bulk statement 必须按实际成功创建的行计量，不能仅在 statement 前做一次固定检查；
- 同一批次若失败，计量应遵循该批次所在 transaction 的提交 / 回滚边界。

## 4. Table 的显式、隐式创建与整表删除

### 4.1 DEFINE TABLE

`DEFINE TABLE` 先读取现有定义：

- 已存在时，根据 `Default/Overwrite/IfNotExists` 决定报错、覆写或直接返回；
- 不存在时分配新的 `table_id`；
- 最终通过 `txn.put_tb` 写 catalog。

证据见 [`define/table.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/define/table.rs#L105-L168)。因此 `put_tb` 既可能是新增，也可能只是覆写定义，不能看到一次 `put_tb` 就无条件增加 table usage。

若定义的是 view，同一 schema transaction 还会清除并重建 view table 数据（[`define/table.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/define/table.rs#L170-L187)）。view record 是否计费属于后续资源口径问题，但其旁路必须保留在账本设计视野中。

### 4.2 隐式建表

非 strict database 中，缺失 table 可由 `Transaction::get_or_add_tb` 动态创建：函数先查 catalog 与 cache，找不到且 database 非 strict 时构造 `TableDefinition` 并调用 `put_tb`（[`tx.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tx.rs#L3186-L3254)）。

该路径不仅由 `INSERT` / `RELATE` 使用，iterator prepare 和部分 `DEFINE EVENT/FIELD/INDEX` 也会调用它。因此只修改 `DefineTableStatement::compute` 会留下直接可利用的 table quota 旁路。

### 4.3 REMOVE TABLE

`REMOVE TABLE` 先读取定义、检查依赖 view、retire indexes，再调用：

- 普通删除：`del_tb` + `delp(table_prefix)`；
- `EXPUNGE`：`clr_tb` + `clrp(table_prefix)`。

证据见 [`remove/table.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/remove/table.rs#L52-L108)。`del_tb` / `clr_tb` 是 table catalog 删除边界（[`tx.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tx.rs#L3343-L3400)），但整表记录通过 prefix operation 删除，不逐条进入 `del_record`。

另外，transaction 的 `delr` / `delp` 指标明确记录为受影响 key 数和字节数未知的 `(0, 0)`（[`tx.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tx.rs#L1271-L1310)）。这说明不能在 prefix 删除结束后，靠当前通用 KV metrics 推导释放了多少逻辑记录或多少字节；所需状态必须在删除前从更高语义层获得，或由后续账本模型另行解决。

## 5. 不能忽略的记录写旁路

`Document::store_record_data` / `purge_record_data` 覆盖正常用户 DML，但不覆盖全部引擎内部 record mutation：

| 旁路 | 当前写法 | 影响 |
|---|---|---|
| materialized view 增量维护 | `set_record` / `del_record` | 不走原始用户 record 的 `Document::store/purge`，但仍经过 typed record provider |
| aggregated view 维护 | 多处 `set_record`，另有直接 record-key 删除 | 只拦 Document 会漏计 |
| `DEFINE TABLE ... AS SELECT` 初始化 | 有一处直接构造 `RecordKey` 后 `tx.put`；聚合初始化也有 `put_record` | 只拦 `put_record` 仍会漏直接 `tx.put` |
| `REMOVE TABLE` | `delp/clrp(table prefix)` | 不逐条调用 `del_record` |

对应源码见 [`doc/table.rs`](../../../../surrealdb/surrealdb/core/src/doc/table.rs#L95-L124)、[`doc/table.rs`](../../../../surrealdb/surrealdb/core/src/doc/table.rs#L350-L377)、[`doc/table.rs`](../../../../surrealdb/surrealdb/core/src/doc/table.rs#L414-L451)、[`define/table.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/define/table.rs#L330-L354) 和 [`define/table.rs`](../../../../surrealdb/surrealdb/core/src/expr/statements/define/table.rs#L750-L772)。

typed provider `put_record/set_record/del_record` 都先构造包含 `ns/db/tb/id` 的 `RecordKey`，再调用 generic transaction mutation（[`tx.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tx.rs#L3954-L4012)）。`RecordKey` 本身保留了逻辑资源上下文并分类为 `Category::Record`（[`key/record.rs`](../../../../surrealdb/surrealdb/core/src/key/record.rs#L12-L57)）。

但 generic `Transaction::put/set/del` 也接受任意 `KVKey`，当前已有内部代码直接传 `RecordKey`。进入 backend `Transactable` 后 key 已编码为 bytes，语义明显弱化；而 prefix delete 又没有逐 key 回调。因此现状不存在一个可以简单插入检查、同时不改调用方就保证零旁路的单函数。

## 6. 候选强制 seam

下表只评价覆盖面，不选择最终实现：

| 候选位置 | 能覆盖 | 会漏 / 风险 | 结论 |
|---|---|---|---|
| statement / parser（如 `DEFINE QUOTA`、`CreateStatement`） | 特定 SurrealQL 语法入口 | import 特殊行为、隐式建表、GQL/未来语言前端、view 内部写、级联、prefix delete | 适合声明语法，不适合作为唯一 enforcement |
| planner / iterator | 常规 DML 行处理 | schema lifecycle 与直接 KV record mutation | 仍然过高 |
| `Document::store/purge` | 正常 DML，能区分 create/update/delete | view 初始化 / 维护、prefix delete | 可做事件上下文，但不是无旁路边界 |
| `put_record/set_record/del_record` | 大多数逻辑 record mutation，保留 ns/db/table/id | 现有直接 `tx.put/del(RecordKey)` 与 prefix delete | 是较窄语义 seam，但需先收敛旁路 |
| generic `Transaction::put/set/del` | 单 key catalog、record、index、graph 等写 | 语义混杂；prefix/range delete仍漏；backend 前 key 很快类型擦除 | 适合物理 KV 观测，不宜直接等同逻辑资源 |
| backend `Transactable` | 最底层已编码 KV | 不天然知道 table/record 业务语义；无法从 prefix delete得到精确受影响量 | 对逻辑 quota 太低 |

基于当前源码，最小完整候选扩展面是：

1. **table catalog transition**：在 `put_tb` 前后明确区分 create 与 overwrite，并与 `del_tb/clr_tb` 的存在→不存在转换配对；这样覆盖显式与隐式建表。
2. **typed record mutation facade**：把全部 `RecordKey` create/set/delete，包括 view 内部直接写，收敛到同一个 transaction-level 语义接口；接口必须区分 create-only 成功、update 和 delete。
3. **table prefix lifecycle**：`REMOVE TABLE` / view 重建等 bulk prefix 清理必须有显式 settlement 入口，因为它们不会发出逐 record delete。

它仍是“候选扩展面”，不是账本算法。后续票需要决定哪些内部 table / view / relation 算可计费资源，以及批量释放使用预存 usage、扫描、异步重算还是其他模型。

## 7. 各 KV backend 的并发与回滚事实

executor 当前总是申请 optimistic transaction。共同接口支持 `commit/cancel` 与 savepoint，但并发冲突语义并不完全一致：

| Backend | 当前 transaction / 冲突事实 | 对“不超卖”的含义 |
|---|---|---|
| Memory | 使用 `with_snapshot_isolation()`；`KeyReadConflict/KeyWriteConflict` 映射为 `TransactionConflict`（[`mem/mod.rs`](../../../../surrealdb/surrealdb/core/src/kvs/mem/mod.rs#L138-L147)、[`err.rs`](../../../../surrealdb/surrealdb/core/src/kvs/err.rs#L98-L108)） | 同 key 竞争可在 commit 暴露冲突；只读额度、写不同 record key 仍不足 |
| RocksDB | `OptimisticTransactionDB` + snapshot；代码明确要求读取 snapshot 与 commit-time conflict detection 对齐；`Busy/TryAgain` 映射为 conflict（[`rocksdb/mod.rs`](../../../../surrealdb/surrealdb/core/src/kvs/rocksdb/mod.rs#L754-L834)、[`err.rs`](../../../../surrealdb/surrealdb/core/src/kvs/err.rs#L123-L137)） | 可依赖被 backend 追踪的竞争 key，但不能把 snapshot count 当互斥 |
| SurrealKV | `Mode::ReadWrite`；`TransactionWriteConflict` 映射为 conflict（[`surrealkv/mod.rs`](../../../../surrealdb/surrealdb/core/src/kvs/surrealkv/mod.rs#L158-L179)、[`err.rs`](../../../../surrealdb/surrealdb/core/src/kvs/err.rs#L110-L121)） | 与上同；需明确制造可检测的事务竞争 |
| TiKV | executor 传入 optimistic，因此使用 `TransactionOptions::new_optimistic()`；只有请求 lock 时才是 pessimistic（[`tikv/mod.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tikv/mod.rs#L365-L384)） | 普通 blind `set` 不能假设会冲突 |
| IndexedDB | 委托外部 `indxdb` transaction；本仓错误映射没有 `TransactionConflict`，共用同 key 并发测试也未覆盖它（[`err.rs`](../../../../surrealdb/surrealdb/core/src/kvs/err.rs#L139-L152)） | 当前本地源码不足以证明可线性化 admission；需补 backend 测试或限定支持范围 |

仓库的共用测试进一步给出直接证据：

- Memory / RocksDB / SurrealKV 运行 `multiwriter_same_keys_conflict`：三个 transaction 盲写同 key，仅第一个 commit 成功，后两个必须失败（[`multiwriter_same_keys_conflict.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tests/multiwriter_same_keys_conflict.rs#L8-L38)）。
- TiKV 运行单独的 `multiwriter_same_keys_allow`：三个 transaction 盲写同 key，三个 commit 都成功，最终值为最后一次写入（[`multiwriter_same_keys_allow.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tests/multiwriter_same_keys_allow.rs#L8-L37)）。

TiKV 的 `putc` 会先读当前值、验证 condition，再写回；TiKV key conflict 会被映射成 `TransactionConflict`（[`tikv/mod.rs`](../../../../surrealdb/surrealdb/core/src/kvs/tikv/mod.rs#L862-L890)、[`err.rs`](../../../../surrealdb/surrealdb/core/src/kvs/err.rs#L154-L168)）。这只证明仓库已有条件 mutation 与冲突错误通道，不代表本报告选择 `putc` 作为最终配额算法。

`TransactionConflict` 是 KVS 层唯一被 `is_retryable()` 标记为可重试的错误（[`err.rs`](../../../../surrealdb/surrealdb/core/src/kvs/err.rs#L49-L88)）。当前用户 query executor 在 commit 失败时把错误包装为 `QueryNotExecuted`，没有对整条用户事务做通用自动重放。因此后续若通过冲突保证不超卖，还必须明确冲突向用户暴露、server 自动重试、还是只重试内部 admission；本票不做决定。

## 8. 事务内不超卖的必要验收条件

基于当前实现，后续原型或实现至少要证明：

1. quota usage / reservation 与对应 table 或 record mutation 使用同一个 `ctx.tx()`；
2. `INSERT` / `UPSERT` 首次 create 的消费受同一 savepoint 管理，create→update 不泄漏；
3. `CANCEL`、statement error、commit conflict 和缺失 COMMIT 都不会留下 usage；
4. bulk 数组与 import 按实际成功新建量计算，已有 record 的 update 不重复消费；
5. `RELATE`、级联 `DELETE`、物化视图内部 mutation 的口径明确且路径覆盖；
6. `REMOVE TABLE` 的 catalog 删除、整表数据删除与用量释放同事务；
7. 每个声称支持的 backend 都有“多个并发 transaction 争最后一个名额”的测试，最终成功新增数不超过 limit；
8. 测试不能只覆盖 blind shared-key `set`，因为 TiKV 的现有测试已证明其行为不同；
9. 对 IndexedDB 要么取得并测试其实际冲突语义，要么不能声称当前源码已证明支持并发不超卖。

## 9. 留给后续决策票的问题

本次研究有意不回答：

- table / record 是否包含系统表、relation table、materialized / aggregated view；
- `UPDATE` 导致记录跨表、view rebuild、`REMOVE TABLE EXPUNGE` 的用量如何结算；
- 采用单 counter、reservation、分片 counter、CAS、锁还是其他 admission 算法；
- quota policy / usage 存在 catalog metadata、普通 KV 还是外部控制面；
- 冲突重试发生在 query executor、内部 quota engine 还是调用方；
- storage-byte quota 统计逻辑值、编码后值、索引 / 图 / changefeed 开销还是磁盘实际占用。

这些选择应分别由资源口径、原生账本模型与事务消费语义票完成；本报告的约束是：不能把 statement hook、`count()` 检查或仅覆盖 `Document` 的实现描述为“数据库原生且无旁路”。
