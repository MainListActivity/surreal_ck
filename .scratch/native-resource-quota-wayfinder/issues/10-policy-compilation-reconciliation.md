Status: done
Label: done
Assignee: /root

# 设计 surreal_ck 策略编译与调和流程

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

subscription event 如何被编译成目标 workspace database 的期望配额策略，并由哪个 root-only 模块幂等下发？需要锁定 webhook/event 去重、期望态与已应用态、失败重试、启动/周期调和、手工 override、workspace 新建时初始套餐、审计记录，以及 fork 不可用或版本不兼容时的安全失败行为。

## Dependencies

- Blocked by: [`摸清 surreal_ck 现有配额与控制面迁移边界`](03-surreal-ck-control-plane-audit.md)、[`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)、[`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)
- Blocks: [`确定升级、降级与已超额工作区语义`](11-upgrade-downgrade-over-limit.md)、[`锁定迁移回填、双仓发布与端到端验收`](13-migration-rollout-acceptance.md)

## Comments

### 2026-07-24 — 已确认的统一期望态与异步调和入口

- webhook、试用到期、override、套餐 revision rollout、workspace 创建、启动扫描、周期扫描和人工重试都汇入同一条资源权益解析与配额调和路径，不各自直接修改 workspace database 的 quota。
- 权威来源变化在 `_system` 事务内生成不可变 `resource_entitlement`、推进 workspace 的 `desired_entitlement`，并以 workspace 与目标 `quota_policy_projection` 为幂等身份创建或合并持久化 `quota_materialization_operation`。
- 独立 root-only `QuotaReconciler` 消费持久化操作，负责连接目标 workspace database、下发原生策略、读回验证并推进 `applied_entitlement`；webhook handler 和 workspace HTTP 请求不直接执行 quota DDL。
- 内存唤醒只能降低延迟，正确性依赖 `_system` 中的期望态和可恢复操作；进程重启、漏事件与 fork 暂时不可用均由启动/周期扫描重新发现。
- 新调和器与现有 workspace member index reconciler 分离，避免把商业资源权威、跨库物化状态和成员索引修复混入同一模块。

### 2026-07-24 — 已确认的不可变目标配额策略

- `resource_entitlement` 是商业资源资格权威；纯函数 compiler 将其转换为不可变 `quota_policy_projection`，后者是待下发到目标 workspace database 的确切执行投影。
- projection 保存完整 typed rules、稳定 rule id、compiler version、目标原生 quota contract/format version 与 canonical digest；物化操作只引用 projection，重试不重新编译。
- 编译器修复或目标 fork 契约升级即使不改变资源权益，也必须生成新 projection 和新物化操作，保留旧 projection 与操作审计链。
- 编译失败时 desired entitlement 保留，workspace sync state 进入 error；已有 workspace 继续由最后确认的 applied policy 强制，新 workspace 保持 provisioning。
- `quota_policy_projection` 不取代资源权益权威，也不从原生 database 反向生成；它只固定“控制面决定下发的确切策略”。

### 2026-07-24 — 已确认的确定性规则编译

- plan revision 中每条资源规则必须有跨 revision 稳定的语义 `rule_key`；override 以 rule key 替换、禁用或调整规则，不按数组位置、selector 文本或 limit 定位。
- compiler 以 resource kind 与 rule key 确定性生成原生 `rule_id`；selector 或 limit 调整不改变规则身份，使原生错误、用量和运营说明可以稳定映射回控制面规则。
- compiler 使用保留 rule key 自动生成 TABLE/FIELD/RECORD 所需的 `.*` 兜底覆盖，再叠加 `^ent_` 等产品正则及精确表名例外；不能依赖内核“未命中即不限额”的兼容默认。
- 重复有效 selector、未知 override key、缺失必要覆盖、非法正则、越界 limit 或无法映射到目标 contract 的规则都使编译失败，不产生可下发 projection。
- canonical digest 基于带版本的结构化 typed rule DTO、规范排序与规范化值计算，不依赖 SurrealQL 文本布局、JSON 字段顺序或运行时遍历顺序。

### 2026-07-24 — 已确认的单 workspace 串行与最新期望态合并

- 每个 projection 只有一个逻辑 `quota_materialization_operation`，状态为 pending/applying/succeeded/failed/superseded；每次真实跨库尝试另写 append-only attempt，记录 lease fencing token、generation、DDL 结果、INFO readback、错误和耗时。
- worker 通过 `_system` 条件更新取得带 fencing token 的限时 lease；同一 workspace 同时只有一个有效下发者，多 Bun 实例不能并发覆盖同一 database 的策略。
- 尚未开始的旧 operation 发现更新 desired projection 后直接 supersede，不重放中间策略；审计仍保留其目标与被替代原因。
- 已执行 DDL 的旧 operation 必须完成 INFO 读回并把 applied 更新为数据库实际确认的旧 projection；若它不等于最新 desired，workspace 保持 pending 并立即调和最新版。
- lease 到期接管者必须先读取原生 INFO 判定前次是否已经提交，不能把超时或断连解释为确定失败并盲目重发。
- operation succeeded 只表示该 projection 曾准确物化；只有 workspace 的 applied projection 与 desired projection 相同时 sync state 才进入 in_sync。

### 2026-07-24 — 已确认的 INFO-first CAS 与外部漂移处置

- 每次尝试先读取原生 quota STRUCTURE，校验 contract/format、canonical policy digest、generation 与 ledger state；当前策略已经等于目标 projection 时不执行 DDL，直接读回确认，原生 generation 无需因商业来源变化而推进。
- 当前原生状态等于 `_system` 最后确认的 applied projection 时，调和器使用 observed generation guard 完整 OVERWRITE 目标策略，不使用控制面自算增量 patch。
- active workspace 的原生策略意外缺失属于危险 fail-open，调和器自动重新 DEFINE 目标策略并告警。
- 原生策略存在但 digest/generation 与最后 applied 记录不一致时判定 `external_drift`；普通 worker 不自动覆盖未知的 root/namespace Owner 变更。
- 平台运营人员可显式选择带 observed generation 重新应用 desired，或把差异建模为新 override、entitlement 与 projection；不得直接修改 applied 指针来“承认”漂移。
- 任一 DDL 后必须再次读取 STRUCTURE；只有目标 digest 完全一致且 ledger 为可信 ready 时才推进 applied。generation mismatch、断连或提交结果未知都先读回，目标已经出现则成功，否则再按漂移或重试规则处理。

### 2026-07-24 — 已确认的配额能力双层 fail-closed

- 新版本 surreal_ck 只允许连接并向用户开放通过原生 quota capability handshake 的配额受管 SurrealDB，不提供退回原版 SurrealDB、旧 fork 或无配额模式继续运行的兼容路径。
- Bun 启动验证 fork identity、quota contract version、STRUCTURE format 与结构化错误能力；不兼容时只保留诊断/运营能力，readiness 失败，并禁止 workspace 创建/激活、scope 签发/换发、资源权益变更与 quota materialization。
- 已应用权益和策略不因控制面不兼容而清空或降级；操作保留 pending/error。短暂不可达可重试，明确 contract/version 不兼容是不可由普通重试掩盖的 deployment fault。
- 浏览器直连使 Bun readiness 不能约束旧 token，因此 SurrealDB 公网 WSS 入口必须使用同一 capability probe 作为流量就绪门；不兼容时撤下入口，不能暴露可写但无 quota 强制的服务。
- 能力恢复后先审计 active workspace 的原生策略与账本，缺失或漂移者重新进入调和，再恢复 scope 签发。镜像矩阵与发布门禁的具体实现留给 fork 发布策略票。

### 2026-07-25 — 已确认的新 workspace provisioning saga

- 创建请求先在 `_system` 原子保留 slug/db name 并建立 provisioning workspace；必须同时绑定明确的 paid/contract/trial subscription item，没有资源权益来源时拒绝创建，不隐式授予 Plus。
- 在创建物理 database 前生成 entitlement 并完成目标配额策略编译，避免无效资源规则留下孤儿 database。
- 创建空 database 后先物化并读回原生 quota，再应用 workspace template、初始化管理员；只有最终 INFO 显示策略摘要正确、账本 ready、模板完成且 desired projection 等于 applied projection，workspace 才进入 active。
- 创建接口返回 provisioning 状态及 operation/workspace 标识，前端查询进度；active 前不得签发或换发目标 database scope。
- 短暂失败保留 provisioning 并从失败阶段幂等重试，不立即删库；永久失败进入 provisioning_error，由平台运营重试或显式清理。
- 用户取消或运营清理可删除从未开放 scope 的未激活 database，但必须保留控制面操作审计墓碑。

### 2026-07-25 — 已确认的 provider event inbox 与单调快照

- webhook 先验证签名，再以 provider + event id 唯一键持久化裁剪后的 append-only inbox；持久化成功即可向 provider 应答，不等待 entitlement resolver 或 quota reconciler。
- 重复 event 幂等返回成功且不重复处理；无效签名拒绝，签名有效但未知类型保留 inbox 并标记 ignored。
- provider adapter 产出带 provider object id 与单调 source revision 的规范化 subscription snapshot；只有 revision 更新时才能推进本地 subscription，旧事件标记 stale_ignored。
- provider 不提供可靠单调 revision 时，webhook payload 只触发 provider API 当前状态拉取，不能直接作为本地状态 patch。
- subscription 更新、受影响 workspace 的 entitlement 重算请求与调和唤醒在同一 `_system` 事务提交；与资源资格无关的支付元数据变化不生成新 entitlement 或 quota operation。
- 周期 provider reconciliation 同样经规范化 snapshot 入口修复漏事件，不维护第二套 subscription 更新逻辑。

### 2026-07-25 — 已确认的失败分类、重建与持久化退避

- 网络/root session 暂时不可用、quota conflict/policy changed、lease 丢失、ledger rebuilding 与提交结果未知属于可恢复错误；提交结果未知必须先 INFO，再决定是否重试 DDL。
- ledger uninitialized/corrupt 进入 root-only maintenance，执行 `REBUILD QUOTA IF NEEDED`；重建期间由内核保持 database 只读，成功后恢复物化。
- contract/version 不兼容、授权错误、workspace/database 映射损坏、编译后仍被内核拒绝为 policy invalid、external drift，以及 active workspace 的 database 不存在，停止自动下发并要求平台运营处理。
- retryable 失败使用持久化指数退避与 jitter，保存 next attempt、attempt count、首次/最近失败时间和结构化错误；进程重启不重置节流。
- 自动重试预算耗尽后逻辑 operation 进入 failed、workspace sync state 进入 error；运营人员可重开同一 operation，或在依赖健康状态明确恢复时重新置 pending，真实尝试继续追加 attempt 审计。
- 新 projection 创建新 operation，不复用旧 projection 的失败摘要；任何失败都不得 REMOVE quota、放宽目标策略或把 desired 回退到 applied。

### 2026-07-25 — 已确认的四类恢复与审计循环

- MaterializationWorker 高频领取明确到期的 pending operation，不以扫描全部 database 发现工作；ControlPlaneSweep 只扫描 `_system`，恢复过期 lease、desired/applied 不一致、到期来源、卡住 provisioning 与可恢复 error。
- NativeAuditSweep 低频、分批读取 active workspace 的原生 quota INFO，发现策略缺失、digest/generation 漂移、ledger 异常和 contract 变化；ProviderReconciliation 独立分页同步规范化 subscription snapshot，不与 database 审计混用。
- 多 Bun 实例使用 namespace 级 sweep lease、持久化 cursor/epoch、分页 checkpoint、有界并发和 jitter 协作；单一 workspace 失败不阻塞整轮，也不能让每个实例重复全量扫描。
- Bun 单独重启在 capability handshake 与持久化 operation/lease 恢复后运行，原生引擎继续强制已有 quota；SurrealDB/WSS 重启、fork 版本变化或兼容故障恢复则必须先完成 active workspace 全量原生审计，再开放公网 WSS。
- scope 签发要求 workspace active、desired/applied 一致且最近原生审计未超过安全时效；审计过期时暂缓签发并优先审计。
- workspace 保存最近 audit 时间、observed generation/digest、ledger state 与结构化结果，使运营面板区分已同步、待同步、已漂移和长时间未验证。

### 2026-07-25 — 已确认的运营面板审计意图

- 产品不提供直接执行 quota DDL 的运营入口；override 创建/终止/排期、failed retry、立即调和/审计、drift reapply/adopt、ledger rebuild、provisioning 重试/清理及 workspace 自动调和暂停/恢复，都先写入 `_system` 审计意图，再由同一调和器执行。
- 每项人工动作记录 OIDC subject、实际授权能力、原因、目标 workspace、执行前状态和幂等 request id；HTTP 成功只表示意图持久化并返回 operation id，不表示数据库已经改变。
- reapply/rebuild 等人工动作仍必须取得 workspace lease、使用 generation guard、写 attempt 并完成 INFO 读回；不得直接修改 applied pointer、native generation/usage、attempt 或原生 policy。
- 紧急 CLI/root 操作不成为产品控制路径，仍被 NativeAuditSweep 识别为 external drift，并要求平台运营显式处置。

### 2026-07-25 — 已确认的 effective/applied 双时间

- override、trial 结束、cancel-at-period-end 与 plan revision rollout 先形成带 effective_at 的计划变更；resolver 可提前验证和编译 projection，但 effective_at 前不得推进 desired 或提前改变原生策略。
- 到达 effective_at 后 ControlPlaneSweep 推进 desired 并唤醒物化；商业资源资格的 effective_at 与数据库实际完成切换的 applied_at 分别持久化和展示。
- 升级延迟期间旧额度继续有效且不能提前享受新额度；降级延迟期间旧额度短暂继续有效且不能为了准点提前收紧，降级后超额语义由后续专票决定。
- 故障恢复后立即处理 overdue 变更但不改写原 effective_at；首期接受受调和 SLA 约束的延迟，不声称毫秒级准点切换。
- 未来若要求严格瞬时生效，需要独立设计 SurrealDB native scheduled policy，不能由控制面时间字段伪装实现。

### 2026-07-25 — 已确认的不可变审计链与可压缩运行状态

- plan/override revision、resource entitlement、quota policy projection、entitlement operation、人工运营意图、terminal materialization operation、真实 DDL/REBUILD attempt，以及 drift/策略缺失/账本异常等安全事件长期不可变保留。
- workspace desired/applied 指针、sync state、operation lease/next attempt/retry summary 与最近原生 audit 摘要是可变且可重建的当前运行状态。
- 无变化的健康 INFO 轮询只更新最近状态并允许按时间桶聚合，不永久逐条保存；异常和状态转换必须生成不可变事件。
- correlation/causation id 串联 provider event 或 operator request、subscription revision、entitlement、projection、materialization operation、attempt 与 native operation id/generation。
- 审计保存 actor kind、OIDC subject、实际授权能力、原因、before/after 引用与 digest、effective/applied 时间及结构化错误；不保存凭证、完整敏感 webhook payload、业务记录内容或完整 SurrealQL 文本。
- 保留期限由部署合规策略配置，但仍被当前 entitlement/projection 或账单解释引用的记录不得清理。

### 2026-07-25 — 已确认的 entitlement/projection 四指针

- workspace 保存 desired/applied entitlement 与 desired/applied quota projection 两组指针：前者解释商业资源资格，后者解释数据库期望和实际执行版本。
- 商业来源变化但规则摘要相同时仍推进 entitlement/projection 审计链，可在无 DDL 的 INFO 读回后同步；compiler/contract 升级但权益不变时只推进 desired projection 并重新调和。
- workspace 只有在 entitlement、projection 两组关系一致，且最新原生 INFO digest 对应 applied projection 时才是 in_sync。
- materialization operation 的幂等身份固定为 workspace + desired projection；该结论同步回补到上游资源权益权威票。

### 2026-07-25 — Resolution

surreal_ck 将资源权益变化统一收敛到 `_system`：provider inbox、manual/contract 操作、到期调度与 workspace lifecycle 生成不可变 entitlement，再由确定性 compiler 产出带稳定 rule id、contract/compiler version 和 digest 的不可变 quota policy projection。workspace 同时维护 entitlement 与 projection 的 desired/applied 四指针；持久化 materialization operation 与 append-only attempt 组成可恢复审计链。

独立 root-only `QuotaReconciler` 按 workspace fencing lease 串行处理最新 projection，先 INFO、再以 generation guard 完整覆盖、最后 INFO 读回；策略缺失自动重建并告警，未知外部策略变更停止并交由运营决定。错误按可恢复、可重建和需人工处置分类，使用持久化退避；MaterializationWorker、ControlPlaneSweep、NativeAuditSweep 与 ProviderReconciliation 四类循环分别承担队列消费、控制面恢复、原生漂移审计和支付事实校对。

新 workspace 使用 fail-closed provisioning saga：明确绑定资源权益、先编译和物化 quota、再应用模板，确认 desired/applied 与账本 ready 后才 active 和签发 scope。新版本只支持通过 quota capability handshake 的配额受管 SurrealDB；Bun 与公网 WSS 入口双层拒绝原版/旧 fork/无配额降级。运营面板只写带 actor、reason、request id 的审计意图，不直接执行 DDL 或修改 applied/usage；商业 effective_at 与数据库 applied_at 分离，不提前切换策略。
