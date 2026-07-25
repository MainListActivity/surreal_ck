Status: done
Label: done
Assignee: /root

# 定义事务内配额消费、释放与批量写语义

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

一次资源变更如何在同一事务内预留、提交或释放用量？需要锁定并发冲突重试、显式事务、单语句批量写、部分失败、UPSERT 实际创建与更新分支、RELATE、新表与删除表、级联删除及 quota counter 热点的语义；任何公开或内部写路径都不能绕过同一套强制逻辑。

## Dependencies

- Blocked by: [`摸清 SurrealDB 写路径与事务内计量扩展面`](02-surrealdb-transactional-enforcement-extension.md)、[`选择原生策略与用量账本的数据模型`](06-native-policy-usage-model.md)
- Blocks: [`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)、[`确定升级、降级与已超额工作区语义`](11-upgrade-downgrade-over-limit.md)

## Comments

### 2026-07-24 — 已确认的并发准入算法

- 首期每个配额 counter 使用同一用户事务内的单共享 key 条件更新：读取 counter 与策略 generation、校验增量，再通过 backend compare-and-set/条件写更新；资源与用量一起提交或回滚。
- 一次操作涉及多个 table 规则桶时，按稳定 `rule_id` 顺序访问和更新，避免不同路径产生不一致的锁顺序。
- 不使用进程内 mutex、独立预留事务、`count()` 扫描或普通 blind `set`；TiKV 的已知 last-write-wins 行为使 blind shared-key 写入不能作为不超卖保证。
- 每个支持 backend 必须通过并发争抢最后一个名额的条件更新契约测试；无法证明该语义的 backend 拒绝启用原生硬配额，不降级为可能超卖的软限制。IndexedDB 只有补齐并通过测试后才能列入支持范围。
- 接受单个热门 table 的 record counter 成为首期写热点；分片 counter、节点额度租约与预分配后置，除非以后能在保持硬上限的前提下证明需要。

### 2026-07-24 — 已确认的事务最终状态语义

- 配额约束事务提交后可见的最终用量，不约束同一事务内部的瞬时峰值。事务按 counter 维护 savepoint-aware 的有符号净增量，并在 pre-commit 合并校验和条件更新。
- 同一事务内创建后删除净增量为 0；满额时“先删除再创建”和“先创建再删除”只要最终用量相同，就得到相同准入结果。
- 同一 counter 在一个事务内只做一次最终条件更新。普通自动提交语句在返回成功前完成校验；显式事务允许到 `COMMIT` 才报告配额超限。
- INSERT/UPSERT 等内部 savepoint 必须同步保存、释放和回滚配额增量；create 分支回退到 update 时不能留下消费。
- `base + delta < 0` 表示账本或 mutation seam 错误，应拒绝提交并将账本标为 `corrupt`，不能静默截断为 0。

### 2026-07-24 — 已确认的批量事务语义

- 单条数组/bulk statement 在自己的事务内全有或全无；最终净增量超限时整条 statement 回滚，不提交“额度内的前 N 条”。
- 显式事务在 quota pre-commit 失败时整体回滚。未包含在显式事务中的多个 statement 仍按各自既有事务边界提交，后续超限不撤销已经提交的前序 statement。
- streaming import 沿用 statement/显式事务边界：已提交批次保留，超限批次整体失败并停止后续处理，不承诺整个文件原子。
- 首期不增加 `ALLOW PARTIAL`、`BEST EFFORT` 或自动截断到剩余额度的模式；需要分批导入的调用方主动控制 batch 并处理超限。
- 批量中的已有 record update 不消费名额，只有最终实际创建与删除形成的净变化进入 counter delta。

### 2026-07-24 — 已确认的 record 存在转换语义

- 所有入口按逻辑 `RecordKey` 的实际存在转换计量：不存在→成功创建为 `+1`，已存在→更新为 `0`，存在→成功删除为 `-1`；计量不依赖 CREATE/INSERT/UPSERT/RELATE 等 statement 名称。
- INSERT ON DUPLICATE KEY UPDATE 与 UPSERT 只有 create 分支真正成功时消费；create 冲突回滚 savepoint 后转 update 时，对应配额增量一起回滚。
- 每个成功创建的 RELATE edge 是 1 条逻辑 record，graph pointer 不额外计数。级联删除按实际删除的每条逻辑 record 释放其所属表用量。
- 非 strict database 隐式建表与紧随其后的 record 创建在同一事务内分别形成 table/record 增量，任一额度失败时资源和全部 counters 一起回滚。
- 物化/聚合 view 的内部逻辑 record mutation 同样经过统一 facade；view 命中 record 规则时，其维护可以使源表写事务超限并整体失败。
- SurrealQL、GQL、import 与引擎内部 view 维护都不得保留绕过 facade 的 record 写路径；`REMOVE TABLE` 继续走整表专用结算，不伪造逐 record mutation。

### 2026-07-24 — 已确认的 table/field catalog 转换语义

- table definition 不存在→存在时，全部命中 table 规则桶各 `+1`；已有定义的 OVERWRITE/IF NOT EXISTS 不增加。普通、relation 与 view table 使用相同存在转换口径。
- 显式 field definition 不存在→存在为该表 `FieldUsage +1`，存在→覆写/修改为 `0`，存在→不存在为 `-1`；隐式 id、relation 的隐式 in/out 与 schemaless 未声明属性不形成 field 增量。
- DEFINE FIELD、DEFINE INDEX 等入口若通过 `get_or_add_tb` 隐式创建缺失 table，同样必须消费全部命中 table buckets，不能按 statement 类型豁免。
- 新 view 的 table 创建与初始化生成的逻辑 records 分别进入 table/record counter；一个 DDL 事务同时触碰 table、field、record 时统一在 pre-commit 校验，任一资源超限则全部回滚。

### 2026-07-24 — 已确认的策略 generation fence

- 无策略状态也有明确 generation；策略定义、修改和移除都推进 generation。任何配额相关写事务第一次触碰资源时绑定 active generation。
- pre-commit 条件更新同时验证 counter 旧值与 generation 未变化；策略更新原子替换策略、初始化新 table buckets 并推进 active generation。
- 写事务先提交时，策略更新读取新用量；策略先提交时，绑定旧 generation 的写事务条件失败并整体回滚，不能在新策略生效后按旧限额提交。
- 降级到低于当前用量是否允许以及超额状态行为留给后续升级/降级决策；本票只固定新旧策略并发的线性顺序。

### 2026-07-24 — 已确认的冲突重试归属

- counter 条件竞争失败时事务整体回滚并返回结构化、可重试的 `quota_conflict`；generation 改变返回可重试的 `quota_policy_changed`；真实用量达到上限返回不可重试的 `quota_exceeded`。
- 显式事务与自动提交 statement 首期都不由引擎透明重放，因为计划可能包含随机值、时间函数、HTTP 调用或其他不可安全重复的副作用。
- surreal_ck/SDK 只对确定 RecordId 等已知幂等操作执行有限次数指数退避重试；非幂等操作将冲突反馈给调用方。
- 未来可以在引擎能可靠证明计划可安全重放后，为该子集增加 bounded retry；首期正确性不依赖自动重试。

### 2026-07-24 — 已确认的 privileged mutation 边界

- active 策略对普通 DDL/DML 不因调用者是 root/namespace Owner 而豁免；database Owner、namespace Owner、root 与引擎内部 view mutation 都经过同一 quota facade。
- root/namespace Owner 的特权是定义、提高、移除和恢复策略，不是静默绕过当前限额；普通 schema migration 会超限时必须先执行可审计的策略变更。
- 唯一受控绕过是显式 quota maintenance/restore/rebuild 模式：只允许 root/namespace Owner 在持久化 database 只读 fence 下启动，完成后必须重建和校验账本，回到 `ready` 前不能开放普通写入。
- 新工作区 provisioning 可以在无策略状态下由 root 应用模板并持续计量，随后下发策略和读回校验，再进入 active。

### 2026-07-25 — 下游确认的超额非恶化公式

- 策略允许把 limit 原子降低到当前 usage 以下；存量不删除，counter 进入 exceeded。
- pre-commit 对每个 counter 接受 `projected <= limit`，或在 `current > limit` 时接受 `projected <= current`；因此超额期间允许净用量持平或下降，禁止恶化。
- 多 counter 事务必须逐项满足该公式，不能跨 table/field/record counter 抵扣；回到 limit 内后立即恢复普通 limit 判断。

### 2026-07-24 — Resolution

首期配额准入使用同一用户事务中的单 counter 条件更新，不依赖进程锁、独立预留事务、扫描或 blind set。事务维护 savepoint-aware 的有符号 quota delta，并以提交后的最终净用量为准；pre-commit 按稳定 key 顺序合并校验和 CAS，使资源 mutation、counter 与回滚保持原子。所有支持 backend 必须证明并发争抢最后一个名额不会超卖，否则不能启用 hard quota。

bulk statement 与显式事务保持全有或全无；streaming import 只在既有 statement/transaction 边界内原子。record、table、field 都按实际存在状态转换计量，UPSERT create→update、RELATE、隐式建表、view 维护、级联删除和整表生命周期全部进入统一语义 seam。

每个写事务绑定策略 generation，策略变更与在途写形成线性顺序。CAS 或 generation 冲突回滚并返回可重试错误，真实超限返回不可重试错误；引擎首期不透明重放用户计划，仅由调用方对已知幂等操作有限重试。普通 mutation 对 root 也无隐藏豁免，只有持久化只读 fence 下的显式 maintenance 模式允许受控绕过并强制重建。

策略可低于存量生效；超额 counter 使用“投影值不超过 limit，或既已超额时不超过 current”的非恶化公式，使删除、等量置换和内容更新继续可用而不允许进一步增长。
