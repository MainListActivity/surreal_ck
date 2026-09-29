Status: done
Label: done
Assignee: product-architecture

# 设计运营面板的人工控制、解释与审计能力

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

平台运营人员如何查看并手动控制工作区计划、内容访问、资源容量、共享 AI 额度和专业模块，同时不破坏订阅权威与审计责任链？

## Dependencies

- [`拆分内容访问、资源容量、AI 额度与功能能力`](03-entitlement-domain-model.md)
- [`定义工作区共享额度与不限席位的公平使用边界`](04-workspace-shared-allowance.md)
- [`设计平台法律内容目录、版本与授权生命周期`](05-content-catalog-licensing-lifecycle.md)
- [`确定升级、降级、到期与历史成果语义`](08-subscription-content-lifecycle.md)

## Expected decision

- 定义运营可执行的赠送、覆盖、撤销、延期、补偿和纠错动作。
- 每个动作记录操作者、原因、来源、有效期、前后值和关联工单。
- 区分计费账户管理员、工作区管理员与平台运营人员能力。
- 定义工作区视图、计费账户视图、权益解释和异常告警。

## Decision

### 0. 已确定：独立运营应用目录

- 用户要求运营应用独立组织，参照仓库已有 `marketing/`（独立 Astro 应用与 pnpm workspace）的边界。采用根目录 `ops/`，不再以 `web/` 内增加运营页面作为最终方案。
- `ops/` 拥有自己的 package、入口、路由、布局、登录流程、构建配置和部署产物；加入 pnpm workspaces，继续使用根 `pnpm-lock.yaml`。
- 技术栈允许与 `web/`、`marketing/` 不同，本票不锁定框架；实现时按运营表单、列表与维护成本选型。共享只限无框架依赖的 DTO/契约，通过 `workspace:*` 引用，不跨包导入客户界面组件。
- 运营前端只调用受保护的后端运营 API，不建立客户 workspace SurrealDB 会话，不获取 root 凭证。
- 后端运营入口和编排集中组织到 `server/src/ops/`；已有 quota 领域服务继续复用，支付、权益计算和审计规则不复制到前端。
- 独立前端可单独构建部署；域名与 IdP client 配置在实施阶段落定。共用 clientId 时需确认运营回调地址及无 workspace 的登录路径，不能以给纯运营账号授予 `_system` 数据库管理员权限解决登录。
- 服务端基于可信登录身份及平台运营能力鉴权；前端目录、域名或 clientId 本身不构成运营权限。

#### 现有实现与迁移边界

- 当前已有 `web/src/screens/QuotaOperationsScreen.svelte`、`server/src/routes/ops-quota.ts` 和 quota 运营服务（`platform_operator` / `platform_operator_capability` / `quota_operator_intent` / `quota_audit_event` / `quota_alert_state` / `quota_notification_outbox` 控制面）；独立应用应复用这些能力，不能按全新无实现系统重建。
- 迁移覆盖现有运营入口、受保护 API 调用、错误展示和操作审计；独立端验证完成后再退役客户前端中的运营界面。
- 平台工作区目录需提供分页及状态筛选（包括已归档），不受运营本人工作区成员关系限制。查看目录不意味着可以读取客户业务表内容。
- 纯运营身份无需加入或创建客户工作区即可登录运营端；需补齐当前 default-scope hook 与运营登录流程的适配。

### 1. 视图

首期五个视图，全部经受保护的后端运营 API 读取，不向运营浏览器暴露 workspace SurrealDB 会话或 root 凭证。

#### 1.1 工作区目录视图

- 平台工作区分页目录：按工作区名称、稳定 slug/ID、计费账户搜索；状态筛选包含正常、保留模式（retention）、超额（over_limit）、已归档。
- 列表行显示当前套餐及 revision、到期时间、service_mode、配额同步状态和是否存在未处理交付异常。
- 查看目录与详情不授予读取客户业务表内容的权利；运营身份本身不产生任何 workspace 成员关系。

#### 1.2 工作区详情视图

- 汇总当前 `product_plan_revision`、计费账户与付款责任人、工作区管理员、当前有效期、已安排的下周期变更（scheduled intent）。
- 四类权益分域展示：资源（实际引擎用量 / 上限 + 采样时间）、内容（可访问范围与允许动作）、AI（周期额度、各 bucket 余额、预留中、已暂停）、功能（启用的 capability 与参数化上限）。
- 期望权益（desired）与实际生效（applied）分开展示；只有已核验生效的能力显示为可用，资源域的 pending 差异必须明示，不得宣称尚未下发的容量已生效（03 §2/§5）。
- 每项权益可展开来源与有效期（见 1.4 权益解释）。

#### 1.3 计费账户视图

- 首期只提供：关联工作区列表、付款责任人、有效与历史订阅来源、该账户维度的人工动作摘要与导航入口。
- 首期不另建复杂客户管理系统；人工写动作一律在工作区详情视图执行，计费账户视图只读。

#### 1.4 权益解释视图

- 对每项有效能力返回 03 §6 定义的 provenance DTO：权益域与 key、有效值 / 允许动作、来源类型与来源记录、客户可见名称、effective_from / effective_until、当前状态（资源域含 desired/applied）。
- 多来源重叠时列出全部贡献来源，而不是只显示“来自 Pro”；人工来源单独标记并链接到产生它的 operator intent。
- 详情页提供“为什么拥有这项能力”的解释路径：权益项 → 来源记录 → 产生来源的审计事件；客户侧工单/对话可引用同一 DTO，不另造解释口径。

#### 1.5 异常告警视图

- 首期异常类型白名单：已付款未交付（provider 已确认收款但 entitlement / materialization 未完成）、权益投影失败、额度结算异常（预留泄漏、重复扣减、退款失败）、配额漂移（drift detected）、授权收回失败。
- 订阅正常到期、合法 over_limit、预期内 retention 均不是系统异常，不进异常列表。
- 异常通过 in_app 通知触达运营（复用 `quota_notification_outbox`，audience=operator），列表支持按工作区 / 异常类型 / 时间筛选；运营可标记已处理但记录不删除。
- 每条异常提供对应的纠正入口：重试交付、漂移转 override、补偿额度或人工修订，从异常直接发起而不是让运营手工拼参数。
- 资源用量阈值类客户提醒沿用既有 `quota_alert_state`（threshold / over_limit，audience=workspace_admin / billing_admin）；客户提醒与运营异常告警分通道，客户侧提示不当作平台故障。

### 2. 运营动作集

按 Expected decision 的六类动词组织；每个动作都是带原因与有效期的、域特定的版本化 grant / override / 授权修订，禁止直接改写当前权益快照（03 §4）。首期动作全集：

| 类别 | 动作 | 关键输入 | 生效语义 | 底层映射 |
| --- | --- | --- | --- | --- |
| 基础计划 | 人工开通或调整基础计划 | 已发布 `product_plan_revision`、workspace、effective_from / until、原因 | 人工来源记为唯一商业基础来源；替换既有基础来源必须指明被替换对象与恢复安排；记录为 operator 来源，不伪造支付成功 | `subscription_upsert`（扩展至 product plan 维度） |
| 基础计划 | 安排下周期套餐 | 目标 revision、生效时间 | 同一时刻至多一份生效中安排；已有安排时明确替换，不产生多份冲突安排 | 既有 scheduled intent 语义 |
| 覆盖 | 临时调整资源容量 | 单一资源、目标限额、期限 | 至多一个资源 override，不与基础模板相加（03 §3） | `override_schedule` / `override_end` |
| 覆盖 | 漂移转正式 override | 由异常列表发起 | 把检测到的配额漂移固化为明确 override，保留漂移证据 | `drift_to_override`（已有） |
| 赠送 | 赠送内容或功能 | 现有内容集合或 feature capability、期限 | 限时 grant，权益取并集；内容仍受来源许可约束，不扩大第三方许可 | 新增 content / feature grant intent |
| 延期 | 延长人工授权 | 目标 grant、新 effective_until | 发布新的授权修订延长既有人工来源；付费订单原始期间保持可追溯 | 新 grant revision |
| 补偿 | 补偿 AI 额度 | 数量、有效期、原因 | 独立补偿 bucket，按 04 §5 消费顺序结算；不直接改总余额、不伪装成套餐额度 | 新增 AI credit bucket grant |
| 撤销 | 撤销人工授权 | 目标 grant / 人工来源 | 终止指定人工来源并重新解析剩余权益；不连带终止付费订阅来源 | grant revoke + entitlement 重新解析 |
| 纠错 | 修正人工记录 | 目标动作、修正值、原因 | 以“撤销原动作 + 新修订动作”复合表达；原 intent 与 audit 保留可追，前后值齐全 | 复合 intent（revoke + grant） |
| 交付 | 重试权益交付 | 目标 intent / operation | 重试既有修订的物化或下发，不新建订单、不重复发放额度 | `materialization_retry` / `provisioning_retry`（已有） |

通用规则：

- 基础计划必须唯一：人工调整基础计划需明确替换对象与恢复安排；赠送不能隐式成为第二份基础套餐（03 §4）。
- 所有缩减动作复用 08 的非破坏性配额语义；生效前必须展示 impact preview：当前与目标权益、将超额的资源、受影响能力，运营确认后提交。
- 到期后回到当时仍有效的权益集合；没有有效基础订阅或人工基础计划时进入 retention 语义，不引入宽限状态。

### 3. 身份与能力

#### 3.1 三类身份能力矩阵

| 能力域 | 计费账户管理员 | 工作区管理员 | 平台运营 |
| --- | --- | --- | --- |
| 购买、续费、取消、商业套餐选择 | 经真实支付流执行 | — | 只能走第 2 节人工动作，记录 operator 来源，不伪造支付事实 |
| 团队协作、成员与工作区设置 | — | ✓ | — |
| 既有额度内的使用配置（成员级内容/AI 开关等） | — | ✓ | — |
| 查看本工作区 / 本账户权益与解释 | ✓ | ✓ | ✓ 全平台只读（含无成员关系工作区） |
| 人工计划、override、赠送、延期、补偿、撤销、纠错 | — | — | 按 capability 细分授权 |
| 内容维护（提交 / 校验 / 发布 / 撤回 / 恢复 / 来源接入） | — | — | `content.*` 系列能力 |
| 异常处理、调和、重试、账本重建、审计 | — | — | `reconcile.audit` / `drift.manage` / `ledger.rebuild` 等 |

- 同一人可同时是计费账户管理员和工作区管理员；平台运营资格独立于两种客户角色，客户身份组合不产生运营资格，反之亦然。

#### 3.2 平台运营资格与细分能力

- 运营身份存于 `_system` 的 `platform_operator`（subject、kind、status、granted_by、granted_at、revoked_at），能力存于 `platform_operator_capability`，由具备授权资格的运营或系统管理员发放与收回，全程留痕。
- 首期能力键沿用现有点分命名并补齐动作集所需的新键：

  | 能力 | 覆盖动作 | 状态 |
  | --- | --- | --- |
  | `quota.read` | 工作区 / 计费账户目录与详情、权益解释 | 已有 |
  | `subscription.manage` | 人工基础计划、安排下周期、撤销人工基础来源 | 已有 |
  | `override.manage` | 临时容量 override | 已有 |
  | `entitlement.grant` | 赠送内容 / 功能、延长人工授权、撤销人工授权、纠错复合动作 | 新增 |
  | `ai.credit.manage` | 补偿 AI 额度桶 | 新增 |
  | `drift.manage` | 漂移转 override、漂移处置 | 已有 |
  | `reconcile.audit` | 调和、审计读取、重试交付（`materialization_retry` / `provisioning_retry` 等 intent 现归此能力） | 已有 |
  | `ledger.rebuild` | 账本重建 | 已有 |
  | `content.*` | 数据维护工作台动作 | 已有（见 12 号） |

- OAuth / OIDC 登录成功只证明身份，不构成运营授权；每个写动作必须经服务端 `platform_operator_capability` 复核（沿用 `requirePlatformOperator`），前端目录、域名或 clientId 不构成权限。
- 首期不增加多级审批流，但所有写动作服务端校验并记录责任人；高危动作（人工基础计划替换、账本重建）在实施期可要求二次确认输入，不属于额外角色。
- 数据维护 MCP 复用同一套运营资格与 capability 复核；纯运营无需 workspace db/ac 即可登录和调用（细节见 12 号）。

### 4. 审计、纠错与结果展示

- 每个动作写一条不可变 operator intent，执行过程与结果追加 audit event；复用 `quota_operator_intent` / `quota_operator_intent_state` / `quota_audit_event` 的结构与状态机（scheduled → pending → processing → processed / failed / terminal_failed），记录结构对齐 Expected decision 的六个必填字段：

  | Expected decision 字段 | 落点 |
  | --- | --- |
  | 操作者 | `operator`（platform_operator 记录）+ `actor_subject` + `authorized_capability` |
  | 原因 | `customer_reason`（客户陈述，可选）+ `operator_reason`（运营必填） |
  | 来源 | 动作产生的 grant / 授权修订 / 订阅来源记录引用；人工动作来源类型恒为 operator |
  | 有效期 | intent 的 `effective_at` + grant 自身 effective_from / effective_until |
  | 前后值 | `before_reference` / `after_reference` + `before_digest` / `after_digest` + `impact_preview` |
  | 关联工单 | 可选 support / 工单引用字段 |

- 另记录幂等键（`request_id` + `input_digest`，重复提交去重）、correlation_id / causation_id 与结果状态，保证可重放、可解释、可归责。
- 操作结果展示“已生效 / 处理中 / 失败”；详情页按资源、内容、AI、功能分域列出应用结果，部分成功不得标为整体完成；资源域 applied 以受管库读回确认为准（03 §5）。
- 历史记录追加保存（schema 层 immutable）；纠错用第 2 节的撤销或修订动作表达，不覆盖过去的支付事实、intent 与审计记录。
- 首期异常列表聚焦第 1.5 节白名单；订阅正常到期和合法 over_limit 不属于系统故障。
- 首期不建设优惠券、自动催收、宽限期、复杂自动退款编排或可执行任意表达式的运营规则编辑器。

## Handoff

- 运营端除套餐与权益管理外，增加数据维护工作台：来源与采集、批次清洗预览、审核与内容库。详细交互和发布边界见 [12 号任务](12-legal-content-ingestion.md)。
- 工作台支持运营在页面发起互联网采集、配置持续更新、清洗和批量审核；任务由后台执行，页面关闭不停止采集。数据相关权限独立于订阅管理权限。
- 用户已确认简化方案：上述完整数据工作台后置，首期采用本地 agent + 数据维护 MCP，在客户端完成采集、清洗与审核交互；ops 保留权限、批次状态与审计入口，详见 12 号最新决定。

- 11 号规格需核对已有原生配额运营能力，优先复用并补足内容、AI 和产品计划解释。
- 11 号规格单独拆出 `ops/` 应用、`server/src/ops/` 入口整理、运营登录适配、全工作区分页目录与旧入口迁移验收任务。
- 实施时注意：本票新增 `entitlement.grant`、`ai.credit.manage` 两个能力键与对应的 grant intent 需要 schema / 枚举扩展；其余动作映射到既有 intent kind。
- 本票为运营面板方案，尚未表示界面或后端动作已经实现。
