Status: done
Label: done
Assignee: /root

# 确定升级、降级与已超额工作区语义

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

升级、降级、取消、付款失败或人工降低额度时，若当前用量已高于新上限，数据库和产品分别进入什么状态？必须明确哪些读写/更新/删除/DDL 仍被允许，是否存在宽限期，何时解除 over-limit，绝不自动删除用户数据，并说明配额更新与并发业务事务交错时的线性化语义。

## Dependencies

- Blocked by: [`定义事务内配额消费、释放与批量写语义`](07-transactional-consumption-semantics.md)、[`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)、[`设计 surreal_ck 策略编译与调和流程`](10-policy-compilation-reconciliation.md)
- Blocks: [`锁定迁移回填、双仓发布与端到端验收`](13-migration-rollout-acceptance.md)

## Comments

### 2026-07-25 — 已确认的低于存量策略与超额状态

- 新策略 limit 低于当前真实 usage 时仍允许原子生效并推进 generation；不能因为存量超额而拒绝降级、取消后的收紧或人工降低额度。
- 现有 table、field、record 全部保留，不自动删除、隐藏、截断或迁移数据。
- 原生 INFO 以 used、limit、exceeded 与 over_by 表达每个有效规则桶/物理表的超额，并继续把原生用量作为权威。
- 调和器读回目标策略与可信账本后正常推进 applied entitlement/projection；workspace 的策略同步状态与用量合规状态分离，允许 `in_sync + over_limit`。
- 超额不是策略应用失败，也不把 desired 回退到旧套餐；后续操作准入与产品处置在本票继续定义。

### 2026-07-25 — 已确认的逐 counter 非恶化准入

- 任一 quota counter 的提交条件为 `projected <= limit`，或在 `current > limit` 时满足 `projected <= current`；超额期间允许最终用量持平或下降，禁止进一步恶化。
- SELECT/LIVE SELECT、现有 record 内容更新及不增加 table/field/record 数量的普通 DDL 不因超额被拒；删除和其它净释放允许。
- 同一事务删除后创建按最终有符号净增量判断：超额桶可以等量置换，回落到上限内后可使用释放出的名额，但不能以事务内瞬时顺序改变结果。
- table bucket、每表 field counter 与每表 record counter 分别判断；不同 record 表之间不能相互抵扣，命中多个 table rule 的共享桶必须全部不恶化。
- view/event/级联等内部副作用同样进入最终净增量；表面上的 UPDATE/DELETE 若导致其它受限 counter 增长，仍按受影响 counter 判定。
- 当 current 回到 limit 以内后立即恢复普通 `projected <= limit` 规则，不保留额外信用或历史超额豁免。

### 2026-07-25 — 已确认的 active workspace 与局部限增

- 正常超额不改变 workspace active 状态，不撤销管理员、普通成员或虚拟员工的身份/scope，也不把整个 database 切成只读。
- 每个事务继续按其实际影响的 quota counters 判定；某一 record/field/table 规则超额不阻止其它仍有额度的独立资源增长。
- 产品单独维护 `quota_compliance = compliant | over_limit | unknown`；它与 workspace lifecycle、subscription status 和 quota sync state 正交。
- unknown 用于 ledger 不可信或原生审计超期，不能假装为 compliant；rebuilding/corrupt、fork 不兼容等安全故障继续走既定只读或 WSS fail-closed，而非普通超额路径。
- 工作区和运营视图显示具体 resource、table/rule、used、limit、over_by、目标套餐与恢复方式；普通权限仍适用，超额既不授予删除/DDL 权限，也不剥夺已有读取/编辑权限。

### 2026-07-25 — 已确认的原因化宽限策略

- 升级在 provider/合同确认的 effective_at 后生成更高权益，不提前开放额度。
- 用户计划降级与 cancel-at-period-end 保留旧权益到已承诺周期结束，随后按 effective_at 切换，不再额外叠加 quota 宽限；override 到期同样按预定失效时间结束。
- 平台人工降低必须显式选择立即或未来 effective_at；需要宽限时直接排期，不使用隐藏的默认期。
- 只有 past_due 默认进入可配置付款补救宽限；grace_until 前继续使用最后有效付费权益和原生策略，首次扣款失败不立即降低。
- 宽限内支付恢复取消待执行降低，未改变资源资格时不生成无意义 projection；宽限到期仍未恢复才进入暂停/取消后的资源处置。
- 宽限只决定商业权益何时切换，不改变内核 quota 算法，也不触发任何自动数据删除。

### 2026-07-25 — 已确认的零增长保留权益

- 曾成功激活的 workspace 在取消、试用到期或 past_due 宽限结束且没有其它有效商业来源时，切换到平台内置的不可变保留权益；从未激活的新 workspace 没有 paid/contract/trial 来源时仍禁止创建。
- 保留权益不是 Plus/Pro/Max 或免费套餐；其 projection 将全部用户可创建 TABLE/FIELD/RECORD 的增长上限设为 0，并只为必要内部系统资源生成受控精确例外。
- workspace 保持 active 但设置 `service_mode=retention`；数据不删除，读取、导出、删除、现有内容更新和其它净用量不增加的事务继续按原生非恶化规则执行。
- 首期明确接受 retention 用户可以删除后等量创建；count quota 只治理资源数量，不能伪装成严格只读。若未来要求取消后只读，必须单独设计不可绕过的 native suspension/write-mode。
- 恢复有效订阅后生成正式 entitlement/projection，调和成功后退出 retention；任何终止路径都不得 REMOVE quota，因为无策略意味着不限额。
- 不自动删除用户数据；任何未来数据保留期限或清理规则必须作为独立产品/合规决策。

### 2026-07-25 — 已确认的升级可用性门槛

- provider/合同确认只表示升级已受理并推进 desired entitlement/projection；原生策略应用与 INFO 读回完成前，产品显示升级处理中，database 继续按旧 applied policy 强制。
- 前端不能根据套餐状态乐观放行，也不存在临时 quota bypass；同 digest 的商业升级仍需 INFO 读回后才能推进 applied 指针。
- 新 projection 确认后才显示新额度可用，并基于权威 INFO 重新计算 quota_compliance；新上限覆盖全部 usage 时转 compliant，否则保留具体 over_limit 项。
- 并发业务事务沿用 generation fence：业务事务先提交则新策略读取提交后 usage；策略先提交则旧 generation 事务整体返回 quota_policy_changed，不允许同一事务跨新旧策略部分提交。

### 2026-07-25 — 已确认的降级预览但不阻塞

- 用户提交降级前读取最新原生 quota INFO，展示各目标 limit、used、预计 over_by 与将被禁止的增长类型；预览不作为用量锁。
- 用户确认后可安排降级，即使预计超额；cancel-at-period-end、付款方终止或合同结束不能因高用量而要求继续付费或先删除数据。
- effective_at 到达时重新读取权威 usage 并照常应用新策略；超额进入非恶化模式，不视为物化失败。
- 平台人工降低同样允许，但审计必须保存影响预览、操作者和原因。
- compiler、ledger 或调和异常会阻止产品宣称降级完成；当前用量超过目标上限本身不会。

### 2026-07-25 — 已确认的 subscription lifecycle 与服务模式解耦

- subscription status 继续表达商业生命周期，workspace `service_mode = standard | grace | retention` 才表达当前产品资源处置；provider adapter 不得把状态名直接翻译成 quota DDL。
- pending 不能激活新 workspace，已有 workspace 的 pending 变更不影响当前有效来源；trialing/active 通常解析为 standard。
- past_due 在 grace_until 前解析为 grace 并保留最后有效权益，宽限结束且无其它来源时转 retention。
- paused 必须结合 paid-through 和规范化暂停策略确定 effective_at，不能假定 provider-specific 语义；默认在有效期结束后转 retention。
- canceled/expired 持续到明确的 paid-through/effective end，之后转 retention；manual/contract subscription 使用同一时间与模式规则。

### 2026-07-25 — 已确认的超额纯派生与自动解除

- quota_compliance 只由当前 applied policy 与可信原生 usage 派生：任一有效 bucket used > limit 为 over_limit，全部 used <= limit 为 compliant，ledger 不可信或审计过期为 unknown。
- 最后一个超额 bucket 经删除等事务回到上限内时，提交即在原生层解除；提高额度则在新 projection 应用并 INFO 读回覆盖现有用量后解除，不设置冷却期或人工确认。
- 仅解决部分 violation 时仍为 over_limit，并保留剩余明细。
- `_system` 只缓存最近观测结果与时间，不保存可手工修改的权威 `is_over_limit`；浏览器直连 mutation 后缓存可短暂滞后，但数据库准入立即使用已提交 counter，按需刷新或 NativeAuditSweep 最终收敛。
- 平台运营不能直接清除超额，只能改变正式权益、修复不可信账本或让实际 usage 下降。

### 2026-07-25 — 已确认的无停写 generation 线性化

- 普通升级/降级不暂停业务写入、不等待长事务，也不取得 database maintenance/read-only fence；策略 generation 原子提交点决定新旧语义顺序。
- 旧策略业务事务先提交时按旧额度合法完成，降级随后读取包含该事务的最新 usage 并可立即形成更大 over_by，不修改已提交数据。
- 策略先提交时推进 generation；所有已绑定旧 generation 但尚未提交的业务事务整体返回 quota_policy_changed，由调用方按既定幂等边界决定是否重试，新尝试使用新策略。
- 不允许同一事务部分按旧策略、部分按新策略提交；用户在降级线性化点前最后一刻合法创建的数据仍被保留，之后所有 affected counters 遵守非恶化准入。
- 只有 ledger rebuild、原始 restore 等 maintenance 使用持久化只读 fence，普通权益切换不使用。

### 2026-07-25 — Resolution

原生 quota 允许新 limit 低于当前 usage 并原子生效，不删除、隐藏或截断 table/field/record；INFO 以 exceeded/over_by 表达超额。超额 counter 使用 `projected <= limit`，或在已经超额时使用 `projected <= current` 的非恶化准入，因此读、现有内容更新、删除、普通零增量 DDL 和等量置换继续可用，任何 affected counter 都不能进一步增长。

workspace 保持 active，身份与 scope 不因普通超额改变；`quota_compliance` 独立派生为 compliant/over_limit/unknown，并与 workspace lifecycle、quota sync、subscription status 和 `service_mode = standard | grace | retention` 正交。状态在所有可信 bucket 回到上限内或升级额度覆盖 usage 后自动解除，`_system` 只缓存观测结果，不能人工清除。

计划降级、取消和 override 到期按既定 effective_at 生效，不因高用量阻止，也不额外叠加宽限；只有 past_due 默认保留最后有效权益到 grace_until。无商业来源的既有 workspace 使用零增长保留权益，允许净零编辑但不自动删数；新 workspace 无来源仍不能激活。升级只有原生 projection 应用并 INFO 读回后才可宣称额度可用。普通策略切换不暂停写入，generation 原子提交点决定新旧事务顺序。
