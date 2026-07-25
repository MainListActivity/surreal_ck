Status: done
Label: done
Assignee: /root

# 锁定迁移回填、双仓发布与端到端验收

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

如何从现有 workspace 内事件式配额无损迁移到原生配额：先部署哪一仓、如何盘点和回填真实用量、如何处理计数漂移、何时停止/删除旧事件与旧表、失败如何回滚？两仓分别需要哪些单元/集成/并发/故障注入/兼容测试，哪些端到端场景证明 database Owner 无法绕过限制且订阅升级降级正确生效？

本票关闭时还要确认两份实施规格的目录、依赖顺序和完成定义，使地图可以正式交给 build/ship 流程。

## Dependencies

- Blocked by: [`设计 surreal_ck 策略编译与调和流程`](10-policy-compilation-reconciliation.md)、[`确定升级、降级与已超额工作区语义`](11-upgrade-downgrade-over-limit.md)、[`确定定制 SurrealDB 的维护、兼容与发布策略`](12-fork-maintenance-compatibility-release.md)、[`设计用户自助配额用量、预警与账单解释契约`](14-self-service-quota-usage-alerts-billing-explanation.md)
- Blocks: none

## Comments

### 2026-07-25 — 已确认的迁移商业权威与盘点门

- 迁移开始先冻结旧 `assign-plan.surql`、`update-plus.surql` 和其它非审计套餐修改，但不冻结正常业务数据写入；冻结持续到新运营入口接管。
- 为每个 active/provisioning workspace 生成 inventory：workspace/db 映射、旧 plan binding 与三档数值、旧 sheet/record counters、静态/动态 quota events、真实 table/field/record 扫描、目标 projection、预计 overage 和所有异常。
- workspace 内 `resource_quota_plan`、`workspace_resource_quota`、`sheet_resource_usage` 都可被 database Owner 篡改，只能作为差异调查线索，不能自动升级为 subscription、entitlement 或 native usage。
- cutover 必须使用运营批准、带 checksum 的 migration assignment manifest；每个 active workspace 恰有一条 plan revision/manual-contract 来源、effective_at 与批准 actor。历史商业记录可决定 Plus/Pro/Max；无法证明时必须人工选择，不能默认为其可篡改 binding。
- 部署方若确认所有无外部商业记录的既有 workspace 原本都应为 Plus，可在 manifest 中批量建立 `manual` Plus assignment；这个决定仍需显式批准和审计，不由迁移器猜测。
- duplicate、unknown workspace、db_name mismatch、缺 plan revision、无批准来源或 inventory 扫描失败都会阻止该 workspace；全量 app 切换前必须清零 unresolved。

### 2026-07-25 — 已确认的 engine-first 总体顺序

- 先发布并认证 SurrealDB fork，再发布依赖它的 surreal_ck；surreal_ck production 绝不能先要求一个尚未晋级的 capability。
- 引擎切换使用全局维护窗：停止公网 WSS/HTTP 写入口并排空连接，取得可恢复 datastore snapshot 且完成 restore drill，运行匹配 CLI 的 fork format migration，再以同一签名 digest 启动所有节点。
- fork 仅以内网/维护模式启动后，依次对 `_system` 与全部 workspace database 执行 `REBUILD QUOTA IF NEEDED`，用独立扫描核对 table/field/record；基础账本必须 ready 并开始持续计量。
- 维护窗内启动 migration-coordinator surreal_ck release，安装 `_system` 控制面 schema、导入批准 assignment manifest、生成 entitlement/projection，并为每个 active workspace 应用 native policy、INFO 读回后标记 `native_policy_active`。
- 只有全部 active workspace 都有匹配 projection 的 native policy、可信账本且无 unmatched blocker 时才重新开放 WSS；旧 events 暂时保留形成双重保护，因此不存在新引擎已开放但仍只依赖可被 Owner 移除事件的窗口。
- 第一阶段对外仍运行 migration-coordinator 产品表面，不开放新套餐 UI；它只连接通过 `native-quota-v1` handshake 的 fork，不再支持 vanilla。

### 2026-07-25 — 已确认的逐 workspace 原子去旧

- 每个 workspace 使用唯一 migration operation、fencing lease 与幂等 request id；开始前 fresh INFO、确认既有 native policy/账本 ready、重新计算 impact/overage，并验证所有 legacy event 目标仍与 inventory 一致。
- 去旧在目标 database 的一个事务中完成：以 observed generation guard 重新断言同一完整 native policy，同时移除 `sheet.resource_quota_guard` 和全部已枚举动态 `ent_*` 表的 legacy `resource_quota_guard`。任何 statement 失败都整体回滚；native policy 在事务前后始终有效。
- 原子提交前的业务事务同时受 native policy 与旧事件约束，提交后的新事务只受 native policy 约束；即使 legacy event 被用户预先移除，native policy 也已阻止超卖。
- 提交后必须 `INFO FOR QUOTA ... STRUCTURE` 读回，验证 policy digest、generation、ledger state、真实 usage 与 expected projection，并确认所有目标 event 已不存在；通过后才推进 `native_verified`。
- 若提交结果未知，先检查 native INFO 与 legacy events 状态，再收敛 operation；禁止盲目重放 DEFINE/REMOVE。已提交但 `_system` 状态未更新时由 reconciler 完成 readback，不回退数据库。
- 维护窗启用 native policy 可以直接产生 `in_sync + over_limit`；高用量不阻止迁移，也不删数，之后使用已锁定的非恶化准入。

### 2026-07-25 — 已确认的 counter drift 处置

- native REBUILD 从真实 catalog/record keys 计算的 usage 是唯一迁移权威；旧 `sheet_count`、`record_count` 和 `column_defs` 数量永不写入 native counter。
- inventory 同时记录旧/新口径差异，供运营解释“为什么迁移后用量不同”，但差异本身不自动调整 plan 或创建 override。
- native counter 与独立真实扫描不一致时立即把 workspace migration 标为 failed/ledger suspect，保持只读或旧 enforcement，执行重新 REBUILD；仍不一致则停止 cohort 并进入引擎故障调查。
- projection 与真实资源覆盖不完整、出现 unmatched table/field/record 时视为 compiler/cutover blocker，不能依赖内核“未命中即 unlimited”的兼容默认。
- 已切换 workspace 的后续 drift 只通过 NativeAuditSweep、正式 override/reapply 或 ledger rebuild 处理，不能手改 cached compliance 或 usage。

### 2026-07-25 — 已确认的 cohort、观察窗与停止条件

- rollout cohort 固定为 synthetic/internal、`max(1, 1%)`、10%、50%、remainder；按 workspace 确定性 hash 分组，避免人工挑选只包含简单 database。
- synthetic/internal 与 1% 各观察至少 24 小时，10% 与 50% 各至少 48 小时；没有足够自然流量时补充合成 DDL/DML、并发临界值和升级/降级演练。
- 每批要求：零 native/独立扫描 mismatch、零 quota false-negative、零未知 drift/ledger corrupt、零结构化错误丢失、零跨 workspace 泄漏；unexpected denial、policy changed 重试率、latency/CPU/KV 写放大保持在发布 manifest 阈值内。
- 任一 false-negative、账本不可信、提交后半切、vanilla/未认证 backend 获得 readiness、结构化 error 被压平或恢复演练失败，都自动暂停且不得豁免继续。
- 单 workspace 商业 assignment/数据异常只隔离该 workspace；引擎一致性、安全或协议问题停止整个 cohort。
- 所有 active workspace `native_verified`、至少一轮全量 NativeAuditSweep clean 后，才切换新订阅/配额产品 UI 和正式 scope gate。

### 2026-07-25 — 已确认的失败回滚与 forward-fix 边界

- format migration 在重新开放写入前失败，可恢复维护窗前 datastore snapshot 并回到旧 binary；一旦新格式开放且产生新写入，禁止用旧 binary 原地 downgrade。
- per-workspace 去旧事务未提交时天然保留 native policy 与 legacy events 双重保护；提交未知走 INFO-first；已确认 native policy 后不自动 REMOVE quota 退回可绕过的旧事件方案。
- 已切换后的应用/控制面问题优先回滚到上一版“仍支持 native quota contract”的 surreal_ck 制品或 forward-fix；不得回滚到只认识 workspace event quota 的 pre-native release。
- datastore format、counter/ledger 或已发生业务写入后的灾难恢复使用 forward-fix 或恢复明确选择的完整 snapshot；普通 SurrealQL export 不能恢复 quota 元数据。
- 任何 snapshot restore 都会使账本 dirty，必须在 maintenance fence 下重建并由控制面重新物化策略、INFO readback 后开放。
- snapshot、manifest、cutover operation、readback 与 restore drill 证据在整个 rollout 和既定备份保留期内保存；不得用“可以重新生成”作为不留恢复证据的理由。

### 2026-07-25 — 已确认的 legacy 停用与延迟删除

- legacy quota events 在每个 workspace 原子 cutover 时停用；旧三张 quota table、旧 counters 与 plan rows 暂时保留为只读迁移证据，但已经完全不参与 enforcement 或商业解释。
- 新工作簿事务立即停止安装动态 quota event；migration runner 删除 `version >= 20` 重装特判。未完成 cutover 的 workspace 仍由迁移协调版显式维护旧事件，不能由普通启动钩子全量重装。
- workspace migration manifest 增加 engine capability 与 native migration state 前置条件；legacy cleanup migration 只能对 `native_verified` 且观察期满足的 workspace 执行。
- 所有 active workspace verified、全量 audit clean、新产品 release 稳定 30 日且 pre-native app 已被 compatibility gate 淘汰后，才发布 cleanup：删除旧 events/tables、shared constants/builders、server installer、manual scripts、字符串错误与旧集成测试。
- 现有 `020-resource-quota.surql` 不原地改写；追加 deferred cleanup migration。新 workspace 在未开放 scope 的 provisioning 流程中先应用 native policy，再完成 cleanup，因此用户永远看不到 transient legacy enforcement。
- cleanup 后发现问题只能 forward-fix 或从完整 snapshot 恢复，不能依赖已删除旧 counter 重建。

### 2026-07-25 — 已确认的双仓测试矩阵

- SurrealDB 单元/compat：grammar/ToSql、regex、revisioned catalog、typed keys/cache、IAM、generation/no-op、usage epoch、format marker 与 errors。
- SurrealDB language/integration：exact/regex table、显式 field、record 全写路径、views/relations、REMOVE/EXPUNGE、bulk/import、savepoint/rollback、超额非恶化、INFO/REBUILD/export。
- SurrealDB concurrency/fault：N 抢 K、policy generation race、multi-node、commit unknown、counter/mutation 各阶段崩溃、rebuild staged/flip 崩溃、restart/restore；每个 production backend 独立运行。
- surreal_ck 单元/集成：system schema、resolver precedence、compiler determinism、四指针、leases/backoff、provider乱序、service modes、operator intent、角色裁剪、alerts 与 browser error mapping。
- 双仓 E2E 至少覆盖：database Owner 修改/删除旧 plan/counter/event、直接 DEFINE/REMOVE schema、table/field/record 临界值、`^ent_` regex、并发最后名额、升级 applied gate、降级 over-limit、grace/retention、override、drift、rebuild、vanilla 拒绝、多 workspace 隔离与运营面板。
- 迁移 E2E 从真实 legacy fixture 出发，执行 inventory→approved manifest→engine format/rebuild→atomic workspace cutover→unknown commit recovery→cohort pause/resume→deferred cleanup，并做 snapshot restore drill。
- 发布验收要求两仓 CI、精确 surrealdb-js HTTP/WSS contract、matching CLI、multi-arch image、SBOM/signature/provenance 与 compatibility manifest 同时通过。

### 2026-07-25 — 已确认的实施规格、依赖与完成定义

- SurrealDB 实施规格位于 [`/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/PRD.md`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/PRD.md)，拆为 8 张实现任务：resource grammar/catalog/IAM → ledger/format → table/field 与 record enforcement → INFO/REBUILD/error → capability/CLI → backend certification → release supply chain。
- surreal_ck 实施规格位于 [`../../native-resource-quota/PRD.md`](../../native-resource-quota/PRD.md)，拆为 10 张实现任务：contract/capability 与 `_system` schema 可先并行，之后 compiler → reconciler → provisioning/lifecycle/API/UI → migration conductor → 双仓 E2E/release。
- surreal_ck `_system` schema 可与引擎实现并行；NativeQuotaClient 集成等待 SDB INFO/error/capability candidate；migration conductor 等待 certified backend；production release 等待签名 stable digest。
- 两份 PRD 分别定义仓内完成标准、必跑验证与跨仓 gates；18 张 task 均为 `ready-for-agent` 的实现追踪入口，但依赖未满足的任务不得越过其 `Blocked by` 开工。
- 地图完成不等于功能已实现；只有两份实施规格的最终 release issue 验收通过，才可宣称原生订阅配额交付完成。

### Resolution

迁移采用 engine-first、真实账本优先、先全量安全启用再逐 workspace 去旧：全局维护窗把 datastore 切到签名 quota fork并为所有 database 重建基础用量，migration-coordinator 导入运营批准的商业 assignment，并在重新开放 WSS 前为全部 active workspace 应用/读回 native policy。之后单 database transaction 只负责 generation-guarded 重新断言 policy 与移除旧 events。INFO readback 是 applied 与 `native_verified` 的唯一完成门，旧 mutable plan/counter 永不成为权威。

rollout 在全部 active workspace 已有 native enforcement 后，按 synthetic/internal→1%→10%→50%→remainder 去除 legacy events 并晋级产品表面；任何超卖、counter mismatch、ledger/format/错误契约问题立即停止。格式开放写入后不原地降级，workspace 已启用 native policy 后不自动 REMOVE quota；依靠事务回滚、兼容应用回滚、snapshot restore 或 forward-fix。旧事件按 cohort 停用，旧表和代码稳定 30 日后才通过 capability-aware deferred migration 删除。

两仓实施规格和 18 张实现任务已经分别落到各自仓库，并固定 contract→candidate→backend certification→migration→signed release 的跨仓依赖。所有已知决策均已解析，无新增 fog，决策地图可以关闭并交给 build 流程。
