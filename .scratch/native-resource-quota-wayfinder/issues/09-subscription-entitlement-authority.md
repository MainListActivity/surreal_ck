Status: done
Label: done
Assignee: /root

# 确定套餐、订阅与配额权益的权威模型

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

在 surreal_ck 中，Plus / Pro / Max 套餐模板、用户订阅状态、workspace 获得的套餐权益和已物化的数据库配额策略分别由谁负责、存在哪里？必须明确一名用户拥有多个工作区、团队付款方变化、试用、暂停、取消、人工 override 和未来企业合同的归属规则，同时保持数据库内核只认识资源策略、不认识商业套餐。

## Dependencies

- Blocked by: [`摸清 surreal_ck 现有配额与控制面迁移边界`](03-surreal-ck-control-plane-audit.md)、[`锁定首期可计费资源与口径`](04-billable-resource-taxonomy.md)、[`确定配额策略的作用域、继承与管理权限`](05-policy-scope-inheritance-authority.md)、[`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)
- Blocks: [`设计 surreal_ck 策略编译与调和流程`](10-policy-compilation-reconciliation.md)、[`确定升级、降级与已超额工作区语义`](11-upgrade-downgrade-over-limit.md)

## Comments

### 2026-07-24 — 已确认的资源主体与付款主体

- 工作区是资源权益主体，计费账户是付款主体，订阅把某个计费账户购买的商业安排分配到具体工作区；用户记录本身不是订阅主体。
- 同一真人可以为多个工作区付款，也可以只作为成员；工作区可更换个人、团队或企业计费账户，而不改变 owner_subject、工作区管理员或成员关系。
- 一个工作区同时只有一份当前资源权益。未来一个订阅覆盖多个工作区时，通过逐 workspace 的订阅项/分配关系表达，不共享可篡改的总 quota。
- 试用授予具体工作区资源权益，不自动覆盖该用户的其它工作区。
- 计费账户、订阅和资源权益权威记录都位于 root-only `_system`，workspace database 内不保存权威商业状态。
- 正式术语使用“资源权益”：它是订阅、试用、人工 override 或企业合同解析后的工作区资源资格；“套餐权益”过窄，不再作为规范词。

### 2026-07-24 — 已确认的不可变套餐版本

- `plan` 是 Plus/Pro/Max 等稳定商业身份，`plan_revision` 是不可变资源规则模板；修改额度只能发布新 revision，不能原地更新旧版本。
- 新订阅项默认绑定 plan 当前 active revision；已有订阅项固定在已选 revision，不因 active revision 指针改变而静默变化。
- 已有工作区迁移到新 revision 必须经过显式 rollout，并逐工作区产生新资源权益，额度降低继续进入后续降级语义。
- 试用、内部套餐和企业合同可复用不可变模板版本；企业定制使用独立内部 plan key，不污染公开 Plus/Pro/Max。
- plan revision 只描述资源资格模板，不保存支付价格、税率、折扣或 provider webhook 状态。
- 工作区当前资源权益保存完整解析规则快照及其来源 revision，不在运行时解引用可变套餐指针。

### 2026-07-24 — 已确认的支付事实与应用订阅权威

- 外部支付 provider 只作为 customer、invoice、billing period、退款/拒付等支付事实权威；surreal_ck `_system` 的规范化 subscription 是应用运行时权威，workspace lifecycle 与配额调和不在请求路径同步查询 provider。
- provider webhook 先按 event id 幂等落库并处理重复/乱序，再更新本地 subscription、触发受影响 workspace 的资源权益重算；周期 reconciliation 修复漏事件。
- manual/contract 来源的订阅可在没有 provider 的情况下存在，不伪造 provider customer id。
- subscription 至少区分 pending、trialing、active、past_due、paused、canceled、expired；cancel_at_period_end、当前周期与结束时间用独立字段表达。
- status 只表达商业生命周期，不直接编码配额处置；各状态对应的保留、降级或冻结行为由后续升级/降级票决定。
- provider 选型、checkout、税务、价格、退款流程和发票 UI 继续在本地图范围外。

### 2026-07-24 — 已确认的不可变资源权益快照

- entitlement resolver 每次只选择一个商业基础来源：有效 paid/contract subscription 优先，否则有效 trial；从未激活的 workspace 都没有时不存在可激活权益且不隐式默认 Plus，曾激活 workspace 失去全部商业来源时改用平台内置的零增长保留权益，绝不移除原生 quota。
- 基础来源解析到不可变 plan revision，再应用至多一个 active override revision，生成新的 immutable resource entitlement snapshot；多个套餐不相加，多个 override 不叠加排序。
- snapshot 保存 workspace、entitlement revision、完整解析规则、subscription item/plan revision/override revision 来源、生效区间、解析时间与状态；workspace 只指向一份 current entitlement。
- 企业长期定制使用独立 plan revision；临时例外使用带操作者、原因、生效/失效时间的版本化 override patch。override 不直接修改 plan、subscription、旧 entitlement 或原生 quota。
- 任一来源变化或 override 到期都生成新快照，旧快照只读保留。新 workspace 必须显式获得 subscription/contract/trial 来源并生成资源权益，才能继续激活。

### 2026-07-24 — 已确认的付款方切换与有效分配

- subscription item 表达某 subscription 在有效期内为一个 workspace 提供一个 plan revision；同一 workspace 同一时刻最多一个有效 item，持久化约束与 resolver 都拒绝重叠。
- 更换付款方通过同一 `_system` 事务结束旧 item 并在同一切换时刻开始新 item，不原地改写旧 subscription、billing account 或 invoice 历史。
- 即使前后 plan revision 和规则相同，来源变化也生成新的 entitlement revision 与审计记录。
- 付款方变化不修改 workspace owner_subject、管理员、成员或 IdP scope；计费账户管理权限与工作区访问权限完全分离。
- 接管未完成前旧分配继续按有效期生效，新付款方不提前成为权威；欠费和宽限对应的资源行为留给后续生命周期票。

### 2026-07-24 — 已确认的商业与执行双层指针

- workspace 分别记录 desired/applied entitlement 与 desired/applied quota projection，并用 pending/applying/in_sync/error 表达 quota sync state；不能用一个 current plan 字段混合商业决定与数据库实际状态。
- resolver 在来源变化时创建新 immutable entitlement 并推进 desired entitlement；compiler 生成不可变 projection，reconciler 下发并 INFO STRUCTURE 读回一致后才推进 applied entitlement 与 applied projection。
- 下发失败时 desired 保留新版本、applied 保留最后确认版本，并记录结构化错误、重试次数和时间；运营面板必须显示 drift。
- 新 workspace 在 desired/applied 一致前不能从 provisioning 进入 active；active workspace 调和失败时继续由旧策略强制，不自动移除或放宽。
- 原生 quota policy 是 applied projection，不反向成为资源权益权威。发现外部 drift 时，控制面显式选择重新下发或把差异转化为新 override。
- 每次物化尝试使用独立 operation 记录关联 entitlement revision、policy generation 与 readback 结果。

### 2026-07-24 — 已确认的控制面能力授权

- 计费账户管理员、工作区管理员与平台运营人员是三组独立能力，不是互斥人群；同一 OIDC 身份可以同时拥有其中任意组合，授权逐能力检查。
- 计费账户管理员管理自己账户的订阅、公开套餐、付款方式和付款方接管，但不能编辑 plan revision、任意资源规则或 override。
- 工作区管理员查看本工作区套餐、资源权益、已应用策略和用量；只有同时也是计费账户管理员时才能执行相应订阅操作，database Owner 本身仍不能修改原生 quota。
- 平台运营人员发布 plan revision、管理 manual/contract subscription 与 override、触发 entitlement/reconciliation，并查看 drift 和审计历史。
- override 只允许平台运营人员创建，必须记录原因、操作者、生效时间和可选到期时间。
- 平台运营身份不复用 `_system.system_admin` 创建开关，也不从普通 OIDC token 固定的 RL Owner 推断；使用独立 control-plane operator authorization。
- 所有 `_system` 写入和原生 quota 下发仍由 Bun 控制面使用 root 完成，浏览器不直接访问 `_system`。

### 2026-07-24 — 已确认的试用建模

- 试用复用正常 subscription + subscription item，使用 status=trialing、具体 workspace、不可变 plan revision 与明确 trial start/end；不建立独立 trial entitlement 系统。
- provider 或 manual subscription 都可处于 trialing；转付费时同一 subscription 转 active，或原子结束试用 item 并开始付费 item，不允许两个基础来源重叠。
- 试用结束未转付费时 subscription 进入 expired/canceled，并触发平台内置保留权益成为新的 desired entitlement。
- 临时赠送额外额度使用有失效时间的 override，企业评估使用内部 plan revision；不滥用 trial 表达其它优惠。
- 每名用户试用次数、信用卡要求等反滥用产品规则不进入资源权益模型。

### 2026-07-24 — 已确认的 `_system` 权威实体

- `_system` 使用当前状态表 + 不可变版本/操作记录，不采用完整事件溯源。权威实体包括 billing account/member、plan/revision、subscription/item、override revision、resource entitlement、provider event、quota materialization operation、entitlement operation、workspace pointers 和 platform operator。
- plan revision、override revision 与 resource entitlement 创建后不可修改；subscription/item 通过单调 revision 推进生命周期，并写 append-only operation 审计。
- provider event 使用 provider + event id 幂等 inbox，敏感 payload 裁剪并设置保留策略。
- workspace 只保存 desired/applied entitlement、desired/applied quota projection 指针与 quota sync 摘要，不复制整份规则；浏览器通过 Bun 授权 DTO 访问，不直接读取 `_system`。
- quota materialization operation 关联 entitlement revision、原生 policy generation、下发错误与 INFO readback。
- 原生迁移完成后删除 workspace database 中旧套餐、用量与事件闸门；任何临时展示投影都必须可重建且明确非权威。

### 2026-07-24 — Resolution

商业控制面以 workspace 为资源权益主体、billing account 为付款主体，subscription item 在有效期内把不可变 plan revision 分配到具体 workspace。用户、workspace 管理员和付款方相互独立但可由同一 OIDC 身份兼任；付款方切换通过无重叠的有效期分配完成，不改写 workspace 所有权或历史。

Plus/Pro/Max 是稳定 plan 身份，额度模板使用不可变 revision；现有订阅只有显式 rollout 才迁移。provider 管支付事实，`_system` 的规范化 subscription 管应用状态；trialing 复用 subscription 生命周期。resolver 选择单一商业基础来源、应用至多一个版本化 override，并生成 immutable resource entitlement snapshot；曾激活 workspace 失去全部商业来源时使用平台内置零增长保留权益，新 workspace 则不得无来源激活。

workspace 分离 desired/applied entitlement 与 desired/applied quota projection；只有原生策略下发并 INFO 读回一致后才推进 applied。`_system` 保存当前状态、不可变版本和 append-only 操作审计，原生 quota 只是执行投影。计费账户管理员、工作区管理员、平台运营人员按能力独立授权，同一人可兼任；长期商业历史和人工原因留在控制面，workspace database 不再承担权威。
