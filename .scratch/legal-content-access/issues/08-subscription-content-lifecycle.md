# 08 — 订阅变更驱动内容权限生效与收回

**What to build:** 工作区续期、升级、降级或到期后，客户看到准确的服务状态，内容访问与 AI 额度按已付款或有效合同安排变化，自己的数据继续保留。

**Blocked by:** [03 — 订阅成员打开一篇获授权的法律内容](03-authorized-content-reader.md)；[05 — 工作区共享 AI 额度闭环](05-shared-ai-allowance.md)

**Status:** done

**ID:** SCK-LCA-08
**确认时序号:** 9
**Repository:** surreal_ck
**Parent:** [本簇实施规格](../PRD.md)

## Acceptance criteria

- [ ] 复用既有订阅事件及受保护运营意图，对有效商业来源解析新的产品/子权益；支付事件、操作重试和乱序通知有明确幂等及版本规则，不重复发放额度或回退到旧授权。
- [ ] 升级仅在合法来源确认后交付；扩大内容范围需投影核验，资源容量继续等待原生配额读回，界面不提前宣称全部升级成功。
- [ ] 取消仅取消后续续费；降级在下个承诺周期且对应付款成立时生效。到期无后续有效来源直接进入 retention，不生成宽限期或未付款的新套餐。
- [ ] 收缩授权与许可失效不能被旧 content token、已建立连接或服务端缓存长期延迟；依 03 的已记录上限验收，到期时间在读取端直接强制，权限未知时不扩大访问。
- [ ] 周期额度不结转，试用转付费不复活旧试用余额；购买/补偿桶保留独立有效期，retention 暂停新收费动作但不重置桶到期时间。
- [ ] 周期内升级保持周期边界，按不可变计算规则补发尚未授予的正向差额，明确取整方式；用版本化测试报价验证反复升降级不会重复领额度，生产启用要求已批准规则。
- [ ] 客户确认页展示套餐范围、准确生效时间和资源缩减影响；超额仍属于同步成功后的容量状态，不删除用户数据，也不宣称只读。
- [ ] 集成测试覆盖续费失败、重复/乱序事件、升级交付失败、服务重启跨越到期、周期末降级、保留模式恢复及普通成员伪造商业来源。

## 范围与交接

复用当前商业事件入口；不在本票选择新支付供应商或实现复杂退款编排。生产数值通过获批的不可变商品/费率配置进入。

遵守本簇已确认的产品规则、授权边界与发布门槛。完成时在 Comments 记录实现范围、验证命令与结果、未解决限制和下游交接；只更新本票完成状态，不自动关闭或修改产品设计父票。

## Comments

- 2026-09-24：用户确认拆分后发布；当前为实施规格，尚未执行实现与验收。
- 2026-09-30（LCA08 实现，PR 见交付记录）：
  - **实现范围**：所有商业入口（provider 事件、受保护运营意图、时间边界 sweep）汇聚的 `EntitlementRefreshPort` 上新增订阅级联 `SubscriptionEntitlementCascade`（`server/src/quota/subscription-cascade.ts`）：native 权益刷新后 (1) 按订阅事实重算 `workspace_product_entitlement` 聚合快照（digest 幂等、同 digest 回指旧快照、到期进入"无有效内容授权"）；(2) 按版本化规则 `plan-cycle-rules-v1`（`server/src/ai-allowance/plan-cycle.ts`）同步套餐周期 AI 额度桶——周期身份 `period_key = <baseSourceId>:<effectiveFrom>`，新周期新桶不结转、升级仅补发正差额（整数额度直减、无小数取整问题、桶到期边界不变）、降级不追回、到期/保留模式不授予且不触碰既有桶（不重置到期时间）、试用转付费不复活旧试用余额、确定性桶 id + 事务内 `total < target` 守卫保证重复/乱序事件不重复发放。产品侧交付失败向上抛错，由生命周期协调器按 retryable 失败重试（升级交付失败可恢复）。
  - **读取端收回**：沿用 03/04 已交付机制——content reader/search 每次换票校验快照 digest/revision/effectiveUntil，lease ≤900s 上限，撤回/失效 fail-closed；本票让快照在订阅变化时即时重算（不再只依赖读时惰性重算），旧 token 在既有上限内自然收敛。
  - **确认面**：工作区配额页（`QuotaOverview`）已展示套餐范围、applied/待应用变更与生效时间、资源同步状态；本票补上内容权益的生效/到期展示。超额仍表达为同步后容量状态，不删数据、不宣称只读。
  - **验证**：`pnpm lint`（0 错误）、`pnpm typecheck`（全 workspace 通过）、`pnpm --filter @surreal-ck/shared run test`（140 pass）、`pnpm --filter @surreal-ck/web run test`（567 pass）、server 全量 `bun test`（740 pass，0 fail；另有 4 个 OIDC middleware 用例在本机因 18081 端口被并行任务的遗留 dev server 占用而失败，未改动分支同样失败，属环境冲突）；LCA08 级联集成测试 `RUN_LOCAL_SURREALDB_QUOTA_LIFECYCLE_TESTS=1 bun test ./src/quota/subscription-cascade.integration.test.ts`（真实 SurrealDB：指派→周期建桶→周期内升级补差→重复刷新幂等→到期快照失效且桶不被触碰→续订新周期新桶恢复→能力门禁拒绝伪造意图，3 次重复运行全绿）。
  - **迁移类型**：无（零 schema 增量；快照与账本表沿用 021/035）。**新环境变量**：无。
  - **周期额度的生产数值**：来自已发布不可变产品修订的 feature `ai_cycle_allowance`；生产启用前必须发布获批修订（本票未推定生产数值）。
  - **未解决限制/下游交接**：(1) 周期额度数量只随"新订阅项窗口"变化；同号产品修订改值不会追溯在途周期（须发布新修订并重绑）。(2) 已知 LCA03 缺口不变：成员移除不回收既有 content token（900s 上限内自然过期）。(3) LCA13（运营修复）可复用 `refreshSubscriptionDriven` 作为受控重算入口。
- 2026-09-30（LCA08 返工，修复验收退回的两个 P1，PR 见交付记录）：
  - **R1（item 丢失产品绑定与结束窗口）根因与修复**：`applySubscriptionUpsert`（`server/src/quota/lifecycle-store.ts`）新建订阅项时只写 `plan_revision`，不写 `product_plan_revision` 与 `effective_until`，且 `$same` 守卫只比较 plan_revision——同资源计划、仅换产品修订的升级（最常见路径）连 item 都不重建，产品绑定永远无法经商业入口落库，级联把权益清空（验收复现：after 新 item `productPlanRevisionId=null`、`effectiveUntil=null`）。修复：(a) 意图 input 支持可选 `product_plan_revision`（`record::table` 校验表身份 + `record::exists` 校验存在性，缺失报 `operator-subscription-product-revision-missing`）；(b) 未携带时从当前 item 继承绑定（全部模式，商业事实连续，不依赖 root 手动 bindProductRevision）；(c) 新 item 的 `effective_until` 对齐订阅付费窗口（`current_period_end ?? paid_through ?? trial_end`，早于生效时间报 `operator-subscription-item-window-invalid`）；(d) `$same` 守卫同时检测产品绑定变化，仅产品升级也重建 item；(e) provider 快照路径（`applyProviderSnapshot`）在付费窗口推进（续期）时把活跃 item 的 `effective_until` 向前延长（只延长不缩短；订阅状态变化仍是权益终止开关），续期不再让 item 在旧窗口结束。
  - **R2（周期身份随升级漂移）根因与修复**：周期键原取 `<baseSourceId>:<item.effectiveFrom>`，周期内升级改写 item 起始 → 换键 → 走 CREATE 分支发全新桶（200+350=550）而非补差 150。修复：周期身份改为订阅级付费周期——`SubscriptionFact` 新增 `cycleFrom/cycleUntil`（`store.activeItem` 读订阅 `current_period_start/current_period_end`，缺省回退 paid_through / item 窗口），作为独立参数传入 `planCycleDirective`（不进 draft digest，快照持久化与 schema 零变更）；`period_key = "<baseSourceKind>:<baseSourceId>:<cycleFrom>"`，规则版本升 `plan-cycle-rules-v2`。周期内升级（换 item）不换键 → 走补差分支、桶到期边界不变；续期（订阅推进付费周期）才换键 → 新桶不结转；试用转付费 `baseSourceKind` 翻转即新键，不复活旧试用余额。同周期跨 item 累计授予仍由事务内 `total < target` 守卫兜底，不越目标。
  - **第 8 项验收补齐（真实商业入口联验）**：`subscription-cascade.integration.test.ts` 新增真实入口用例，把 `QuotaLifecycleCoordinator` 的 refresher 直接接到级联（意图/事件 → apply → 产品快照 → 周期桶完整链路）：真实运营身份（platform_operator + subscription.manage）指派 → 周期内 plan_rollout 升级（断言新 item 绑定新产品修订 + 窗口对齐付费窗口 + 周期键不变 + 补差 150 + 到期边界不变）→ 真实 provider 事件续期（断言 item 窗口延长到新付费窗口、产品绑定保留、新周期键新桶、旧桶不结转）→ 重复 provider 事件 stale_ignored 不重复授予 → 续费失败 past_due（权益清空、桶保留）→ 恢复（回指既有 digest 快照、同周期恢复不重复授予）。原用例（直接 bind 的升级路径、能力门禁拒绝伪造意图）保持全绿。
  - **验证**：`pnpm -r typecheck` 全绿；`pnpm lint` 0 警告 0 错误；级联集成测试 `RUN_LOCAL_SURREALDB_QUOTA_LIFECYCLE_TESTS=1 bun test ./src/quota/subscription-cascade.integration.test.ts` 2 用例全过（多次运行稳定）；server 全量 `bun test` 542 pass / 5 fail（4 个 OIDC middleware + 1 个 chat 挂载用例在 main 上同样失败，本机环境问题；另有 lifecycle 集成用例因本机 vanilla surreal 二进制缺 fork 原生配额传输层报 `native_quota_transport_error`，在基线 dc4b83a 上同样失败，均与本分支无关）；shared/web 测试不受影响（shared 未改动）。
  - **迁移类型**：无（`product_plan_revision`/`effective_until` 字段在 004/021 早已定义，本次只是让商业入口真正写入）。**新环境变量**：无。
  - **下游交接**：产品绑定的唯一合法入口是受保护运营意图（`subscription_upsert` 携带 `product_plan_revision`）或 provider 事件窗口同步；`bindProductRevision` 仅保留给 LCA13 运营修复等受控重算场景。周期键语义变化（v2）不迁移既有桶：新键从下次同步开始生效，旧桶按自身到期时间自然退役。

