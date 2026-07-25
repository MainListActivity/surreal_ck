Status: done
Label: done
Assignee: /root

# 设计用户自助配额用量、预警与账单解释契约

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

工作区管理员、计费账户管理员与普通成员分别能在产品中看到哪些套餐、desired/applied 资源权益、原生配额用量、剩余额度、超额和 drift 信息？需要确定 QuotaExceeded 的浏览器领域映射、用量刷新与缓存、阈值预警及去重、套餐/override/账单解释、普通成员裁剪、内部运营视图与客户视图边界，使用户能理解“为什么被限制”而不暴露底层策略或其它工作区信息。

## Dependencies

- Blocked by: [`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)、[`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)、[`设计 surreal_ck 策略编译与调和流程`](10-policy-compilation-reconciliation.md)、[`确定升级、降级与已超额工作区语义`](11-upgrade-downgrade-over-limit.md)
- Blocks: [`锁定迁移回填、双仓发布与端到端验收`](13-migration-rollout-acceptance.md)

## Comments

### 2026-07-25 — 已确认的角色化读取边界

- 配额产品读取统一走 Bun 的窄控制面接口，由它组合 `_system` 的商业/调和状态与原生 `INFO FOR QUOTA ... STRUCTURE`；这不是工作簿或数据表 CRUD 代理。浏览器不得直接读取 `_system`，也不得自行拼接 desired/applied 状态。
- 工作区管理员可看本工作区的 applied 套餐/资源权益、待生效变更、table/field/record 有效上限、逐命中表用量、剩余量、容量状态、超额、服务模式、sync/drift 摘要与观测时间；不能看 provider id、付款方式、内部运营备注或其它工作区。
- 计费账户管理员可看该账户正在付款的 workspace 分配、plan revision、subscription status、paid-through/grace/cancel 时间、资源上限与聚合利用率；若不是该工作区成员，不返回物理表名、逐表用量、正则命中清单或业务 schema。
- 普通成员不看套餐、账单、desired/applied、override、drift 或全表真实用量。配额阻止其当前操作时，只返回所操作资源的裁剪原因和“联系工作区管理员”；避免用全表 record 数泄露被行权限隐藏的数据。
- 平台运营读取使用独立 operator capability，可查看跨工作区 desired/applied 四指针、商业来源、projection/native generation 与 digest、逐规则/逐表用量、drift、ledger、重试与审计链；仍不能读取业务记录内容、凭证、完整 query 或敏感 provider payload。
- 三种管理身份按能力取并集而非互斥页面。付款管理员与工作区管理员是同一人时，同时获得订阅操作和详细工作区用量；仅凭工作区 Owner 不能推导付款权，仅凭计费账户成员也不能推导 workspace 数据访问权。

### 2026-07-25 — 已确认的客户配额摘要契约

- 共享版本化 DTO 顶层包含 `format_version`、viewer capabilities、workspace、applied/desired resource summary、service mode、quota sync state、quota compliance、capacity state、observed_at、usage_trusted、stale 与可见 actions。
- “当前套餐/当前额度”严格指 applied entitlement/projection；desired 只以“待应用/计划于何时生效”单列。未完成 INFO 读回的升级不能提前显示为可用，调和失败也不能用 desired 覆盖 current。
- 客户资源项使用稳定的 product resource key 与本地化 label，不暴露 native rule id、database name、policy digest 或 generation。控制面用 projection 的稳定 rule key 把原生 usage/error 映射回产品说明。
- exact selector 显示对应数据表；regex selector 优先显示 plan revision 中审核过的客户说明，例如“名称以 `ent_` 开头的数据表”，工作区管理员可展开查看规范 regex 与实际命中表。普通成员和非成员计费管理员都不获得该展开数据。
- finite limit 返回 `used`、`limit`、`remaining=max(limit-used,0)`、`over_by=max(used-limit,0)` 和利用率；unlimited 明确显示“不限”且不伪造百分比。limit=0 且 used=0 是“无可新增容量”而不是超额，used>0 才是超额。
- `quota_compliance` 继续只有 compliant/over_limit/unknown；另以 capacity state 区分 normal/warning/critical/at_limit/over_limit/unknown，避免把“刚好用满”误称为超额。
- `usage_trusted=false`、ledger 非 ready 或观测超过安全时效时，used/remaining 显示“暂不可确认”而不是 0；可展示最后可信值但必须带时间和 stale 标记，任何写入准入仍以数据库实时判断为准。

### 2026-07-25 — 已确认的刷新、缓存与一致性说明

- 配额页首次打开、工作区切换、计划/override 操作完成、原生 quota 错误和用户点击刷新都触发读取；页面可见时每 60 秒轮询，隐藏或离开页面即停止，不建立 LIVE quota 通道。
- Bun 对同 workspace 的原生 INFO 做请求合并并允许最多 15 秒的共享缓存；显式刷新可绕过旧缓存，但同一 actor/workspace 最短 10 秒一次。所有响应返回商业状态时间、原生 observed_at 和 cache age。
- 任何会改变资源权益、解决 drift 或 rebuild ledger 的运营动作都必须在写入审计意图前进行 fresh preflight，不能依赖客户页缓存；动作完成仍以调和器 INFO readback 为准。
- 浏览器直连 mutation 成功后无需同步回写应用计数；摘要最终由原生 INFO 收敛。QuotaExceeded 后立即刷新只是改善解释，不参与决定数据库是否允许该操作。
- NativeAuditSweep 对 active workspace 默认以不超过 15 分钟的目标时效分批刷新，既作为后台配额摘要来源也驱动阈值预警；无法满足时把状态标为 stale/unknown 并发运行告警，不能继续展示“健康”。

### 2026-07-25 — 已确认的 QuotaExceeded 领域映射

- shared 层定义稳定 quota failure union，至少区分 exceeded、conflict/policy_changed、ledger_unavailable、generation_mismatch、policy_invalid 与 incompatible；只读取 SDK 保留的 `code/retryable/details`，message 仅作未知错误展示。
- 工作区管理员看到客户安全的全部 violation：资源类型、可见表、当前值、上限、事务净增量、预计值、超出值与恢复建议；普通成员只看到自己操作涉及的资源类型、可见表和“容量不足/暂不可用”，不返回总量、rule id 或其它表 violation。
- `quota_exceeded` 不自动重试；UI 保留记录草稿、字段编辑或 DDL 输入，并明确批量事务未提交。删除、减少用量、升级或联系管理员是可选恢复动作，不能笼统提示“稍后重试”。
- `quota_conflict`/`quota_policy_changed` 只有在调用方证明操作幂等时才自动重试最多一次，随后刷新摘要；ledger unavailable 依据 retryable/state 给出稍后重试或联系平台，generation mismatch 与 incompatible 禁止盲重试。
- 每个裁剪响应保留 correlation id，平台运营可用它追到 native error/operation；客户响应不携带完整 SurrealQL、record id 清单或内部 database 标识。

### 2026-07-25 — 已确认的阈值预警与去重

- 首期只对 finite limit 建立固定 80%、90% 和 100% 三档容量阈值；100% 表示 at_limit，“超额”只在 used>limit 时成立。unlimited、unknown 和不可信 usage 不产生容量百分比预警。
- 80% 发送给工作区管理员；90%、100% 和 over_limit 同时发送给工作区管理员与相关计费账户管理员。普通成员不接收主动容量预警，只在其操作被拒时看裁剪说明。
- 每次 NativeAuditSweep、调和 readback、fresh quota page 读取和 QuotaExceeded 后刷新都可评估阈值；预警目标 SLA 为后台观测后的 15 分钟级，不承诺与浏览器直连写入实时同步。
- 去重键包含 workspace、applied projection、resource key、可见 table identity、threshold 与 over-limit episode。同一阈值只通知一次；使用率降到阈值以下至少 5 个百分点后才重新武装，projection 改变时重新评估但不重复发送相同事实。
- `_system` 保存可压缩的 alert state 和不可变 notification outbox/event；首期必须提供产品内 banner/通知记录，邮件、短信或第三方推送是后续 channel adapter，不改变阈值语义。
- stale/unknown、ledger corrupt、sync error 和 external drift 是运行健康告警，不伪装成容量预警；客户只看可行动的简化状态，平台运营接收完整诊断。

### 2026-07-25 — 已确认的套餐与账单解释

- 客户说明按“为什么有这份额度”组织：applied plan/revision、来源类型（paid/trial/contract/manual/retention）、生效与应用时间、服务模式、下一次计划变更，以及是否存在平台 adjustment；不从 native policy 反推商业原因。
- override 同时保存客户可见的简短 `customer_reason` 与仅运营可见的 `operator_reason`。客户只看到 adjustment 造成的有效额度、起止时间和客户说明，不能看到工单、风控或内部备注。
- 工作区管理员若不是计费账户管理员，只能看到“由某计费账户提供/联系计费管理员”，不能查看 invoice、付款方式、provider customer、拒付细节或执行订阅动作。
- 计费账户管理员可以查看 subscription status、grace/cancel/paid-through 和所分配工作区，但价格、税、优惠券、退款和发票 UI 仍在本地图范围外；provider 尚未确认的计划变更只能显示 processing，不能改变 applied 配额。
- 客户历史只展示套餐、服务模式、额度 adjustment、effective/applied 和超额状态转换的裁剪时间线；内部操作链、attempt、原生 generation 和错误细节留在运营视图。

### 2026-07-25 — 已确认的内部运营面板与手工控制

- 运营面板支持按 workspace id/slug、计费账户和经授权的 OIDC subject 定位对象，展示订阅来源、applied/desired entitlement/projection、有效/计划额度、原生用量、capacity/compliance、sync/drift、ledger、最近 operation/attempt 和不可变审计时间线。
- 所有按钮按细粒度 capability 控制，至少分为全局只读、subscription/manual-contract 管理、override 管理、reconcile/audit、drift 处置与 ledger rebuild；不使用一个笼统“后台管理员”布尔值，也不复用 workspace 创建开关。
- 手工改变“租户计划”不能直接改 workspace.current_plan、applied pointer 或原生 DDL：长期赠送/合同用 manual/contract subscription revision，临时加减额度用带期限 override，支付套餐变化走规范化 subscription 流程。
- 每次变更先显示 current/target diff、最新用量、预计超额项、effective_at 与受影响能力；操作者必须填写 customer reason、internal reason 和幂等 request id，并二次确认。首期由一名拥有对应 capability 的运营人员即可提交，不强制双人审批。
- 降低额度即使会超额也可排期或立即提交，但不能删除数据；页面明确提示将进入非恶化模式。HTTP 成功只表示审计意图已落库，UI 跟踪 operation，直到 applied/readback 后才显示完成。
- drift 只允许“重新应用 desired”或“将差异转化为正式 override”两条产品路径；重试、立即审计、rebuild、暂停/恢复自动调和等动作继续复用既定审计意图与 reconciler，不提供任意 quota DDL 控制台。
- 平台运营入口使用正常 OIDC + 独立 operator authorization 的 `/api/ops` 边界，不复用为机器 hook 保留的 `/api/internal`，也不把 root token 下发到浏览器。

### 2026-07-25 — 已确认的隔离、枚举与审计要求

- 产品读取同时检查 workspace membership、billing account membership 和 operator capability，并按三者能力并集合成响应；对象 id 不构成授权，禁止通过更换 slug/id 枚举其它工作区。
- 客户 DTO 使用 allowlist 序列化，不能把原生 STRUCTURE 或 `_system` record 直接透传后再在前端隐藏；日志也必须使用相同敏感字段裁剪规则。
- 所有订阅/override/调和/rebuild 意图、预览快照、actor capability、原因、request/correlation id 与最终 readback 进入既定不可变审计链。纯读取只记低成本安全审计，不永久保存每次轮询 payload。
- 运营 impersonation 不进入首期；排障使用平台运营自身身份和审计权限，不能伪装成客户角色操作。

### Resolution

配额展示采用 Bun 组合的角色化控制面 DTO：工作区管理员看本工作区详细有效额度与逐表可信用量，计费账户管理员看付款关系、订阅生命周期和不泄露 schema 的聚合利用率，普通成员只在相关操作失败时获得裁剪说明，平台运营按独立 capability 查看完整 desired/applied、native usage、drift 和审计。身份能力可重叠，因此同一人兼任付款管理员与工作区管理员时自然获得两类能力。

客户界面严格区分 applied current 与 desired pending、quota compliance 与 capacity state，并显式标注 usage 信任度和观测时间。摘要采用短缓存、可见页轮询与 NativeAuditSweep 收敛；80/90/100 阈值通过持久化 episode 去重。结构化 quota error 映射为共享领域结果，保留草稿且不解析 message。

运营面板可以手动查看和控制工作区计划，但所有控制都建模为 subscription、manual/contract assignment 或版本化 override 的审计意图，经 entitlement/compiler/reconciler 和 INFO readback 生效；不直接修改 current/applied/usage 或执行任意 quota DDL。客户说明同时解释商业来源、有效额度、计划变化和恢复路径，并严格裁剪内部原因、其它工作区与业务数据。
