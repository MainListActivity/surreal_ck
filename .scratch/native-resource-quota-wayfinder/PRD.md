Status: done
Label: done

# SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图

## Destination

形成一套经 `/Users/y/IdeaProjects/surrealdb` 与当前仓库源代码验证、可直接转入实施计划的双仓规格：SurrealDB fork 提供不可被 database 管理员绕过的原生配额策略、用量计量和事务内强制；surreal_ck 提供 Plus / Pro / Max 套餐、订阅权益、策略编译、下发与调和。

地图完成时，所有会改变数据模型、SurrealQL 管理面、一致性语义、升级降级行为、迁移方式或双仓发布顺序的决定都已落在已关闭的子票中，并可据此分别生成两份实施规格。

## Notes

- 本地图默认只做 wayfinding，不实施配额引擎或订阅功能。
- canonical tracker 位于当前仓库；最终实施规格必须明确拆成 `surrealdb` 与 `surreal_ck` 两部分，并给出跨仓契约。
- 当前事实基线：`shared/sql/workspace-template/020-resource-quota.surql` 的套餐、绑定、用量和事件都位于 workspace database；database `Owner` 可以修改这些记录或移除事件，因此它只保护正常应用路径，不是不可绕过的计费边界。
- 既有架构约束继续成立：一个工作区对应一个 workspace database；浏览器默认直连；跨工作区隔离依靠 database 边界；surreal_ck root 仅用于控制面和生命周期维护。
- 每个后续 session 应按需使用 `research`、`grilling`、`domain-modeling`、`surrealql`；涉及具体 SurrealQL 时先加载 `surrealql`。
- 本图统一使用“资源权益”表示工作区当前获准使用的资源上限集合；“套餐权益”不再作为规范词。
- 本地 Markdown tracker 没有原生 dependency/assignee API，因此子票用 `Assignee:` 与 `## Dependencies` 表达 claim 和阻塞关系。

## Decisions so far

<!-- 每个已关闭决策只在这里写一行摘要与链接；详细答案只保留在对应子票。 -->

- [`摸清 SurrealQL 资源定义与权限扩展面`](issues/01-surrealql-resource-definition-extension.md) — 配额资源需贯穿完整 catalog 管线；机械结构可参考 Sequence，但管理授权必须高于受限 database 的 Owner。
- [`摸清 SurrealDB 写路径与事务内计量扩展面`](issues/02-surrealdb-transactional-enforcement-extension.md) — 不存在一个天然 hook；完整强制需覆盖 table catalog 转换、typed record mutation 与整表生命周期，且不同 KV backend 的并发冲突保证并不一致。
- [`摸清 surreal_ck 现有配额与控制面迁移边界`](issues/03-surreal-ck-control-plane-audit.md) — 当前只有 workspace 内静态套餐与可篡改事件守卫，没有 subscription/billing 权威；后续应保留 root 生命周期和直连架构，替换事件 enforcement 并建立跨仓契约。
- [`锁定首期可计费资源与口径`](issues/04-billable-resource-taxonomy.md) — 首期只做 table、field、record；规则以精确表名或标准正则选表，table 做匹配集合计数，field/record 按命中表独立计数。
- [`确定配额策略的作用域、继承与管理权限`](issues/05-policy-scope-inheritance-authority.md) — 策略按 database 物化且只由 root/namespace Owner 管理；冲突、查看、迁移和未命中默认语义固定，套餐继承与兜底覆盖由 surreal_ck 控制面承担。
- [`选择原生策略与用量账本的数据模型`](issues/06-native-policy-usage-model.md) — 原生采用受保护的原子策略快照与事务精确、可重建的持续用量账本；重建只读，语义写入增量计量，旁路恢复必须标脏重算。
- [`定义事务内配额消费、释放与批量写语义`](issues/07-transactional-consumption-semantics.md) — 用同事务净增量与条件 counter 更新保证不超卖；批量按事务原子，全部 catalog/record 路径统一计量，冲突显式返回且普通 root mutation 不豁免。
- [`设计原生配额 SurrealQL、错误与可观测契约`](issues/08-native-surrealql-errors-observability.md) — 用 database 单例 QUOTA DDL、generation guard、专用 INFO/REBUILD、结构化错误与低基数观测形成稳定跨仓管理契约，普通 export 不携带 quota。
- [`确定套餐、订阅与配额权益的权威模型`](issues/09-subscription-entitlement-authority.md) — workspace 持有不可变资源权益，billing account 付款；版本化套餐、规范化订阅、单一 override 和 entitlement/projection 四指针在 `_system` 形成商业与执行权威。
- [`设计 surreal_ck 策略编译与调和流程`](issues/10-policy-compilation-reconciliation.md) — 不可变 entitlement/projection 四指针经持久化操作与 INFO-first root 调和落到配额受管 SurrealDB；新 workspace、运营动作、重试审计和多实例扫描统一 fail-closed。
- [`确定升级、降级与已超额工作区语义`](issues/11-upgrade-downgrade-over-limit.md) — 降低额度可形成不删数的超额状态，事务逐 counter 只许非恶化；付款宽限、零增长保留权益、服务模式和 generation 切换共同定义升级降级生命周期。
- [`确定定制 SurrealDB 的维护、兼容与发布策略`](issues/12-fork-maintenance-compatibility-release.md) — 私有 stable fork 与分层上游化并行；自有签名 digest、fork-required 数据格式、能力握手、精确 SDK/CLI 矩阵、迁移门禁和 backend allowlist 共同保证只连接可认证的配额受管引擎。
- [`设计用户自助配额用量、预警与账单解释契约`](issues/14-self-service-quota-usage-alerts-billing-explanation.md) — 角色化控制面 DTO 区分工作区、付款与运营能力；可信用量、容量阈值、结构化错误、客户解释和审计意图共同支撑自助页面及可手工控租户计划的运营面板。
- [`锁定迁移回填、双仓发布与端到端验收`](issues/13-migration-rollout-acceptance.md) — engine-first 维护迁移、真实账本回填、批准的商业分配、逐 workspace 原子切换、分 cohort 停止门与延迟清理共同形成可恢复发布路径，并产出两仓实施规格。

## Not yet specified

无；所有已知决策已关闭并转入两仓实施规格。

## Out of scope

- 本地图不选择支付供应商，也不设计 checkout、价格、税务、优惠券、退款或账单 UI。
- 本地图不重新证明 SurrealDB 已有 namespace/database IAM 隔离，也不重做 surreal_ck 的 workspace 身份架构。
- 本地图不以代理所有业务 DDL/DML 作为主要解法；目标是数据库原生强制。若源码研究证明某项能力无法原生实现，只记录该限制并另行决策。
- 本地图不直接提交 SurrealDB fork 或 surreal_ck 的生产实现。
- 首期不实现 index 或持久存储字节硬配额；它们需要独立资源口径与 KV 计量方案，见 [`锁定首期可计费资源与口径`](issues/04-billable-resource-taxonomy.md)。
- 首期不实现 LIVE subscription、并发查询或请求速率配额；这些运行时资源需要租约或时间窗口模型，见 [`锁定首期可计费资源与口径`](issues/04-billable-resource-taxonomy.md)。
- 首期不提供毫秒级定时原生策略切换；商业 effective_at 与数据库 applied_at 分离，严格瞬时切换需要未来扩展 native scheduled policy，见 [`设计 surreal_ck 策略编译与调和流程`](issues/10-policy-compilation-reconciliation.md)。
- 首期不提供取消后的严格只读 native suspension/write-mode；保留权益只保证资源数量零增长并允许净零编辑，见 [`确定升级、降级与已超额工作区语义`](issues/11-upgrade-downgrade-over-limit.md)。
- 本地图不设计终止订阅后的自动数据删除或数据保留期限；现有数据始终保留，未来清理规则必须作为独立产品与合规决策，见 [`确定升级、降级与已超额工作区语义`](issues/11-upgrade-downgrade-over-limit.md)。
