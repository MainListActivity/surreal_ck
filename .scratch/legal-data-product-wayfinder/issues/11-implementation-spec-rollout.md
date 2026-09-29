Status: done
Label: done
Assignee: product

# 汇总实施规格与分阶段发布顺序

## 已拆出的实施簇

- [平台法律内容 MCP 与独立运营端](../../legal-content-mcp/PRD.md)：SCK-LCM-01 至 10，覆盖契约、内容库、运营身份、独立 ops、校验发布、MCP、本地 runner 和端到端验收。
- [ma_hono OAuth / DCR](/Users/y/IdeaProjects/ma_hono/.scratch/ops-mcp-oauth/PRD.md)：IDP-OM-01 至 03。
- 上述两簇先行交付内容维护链路；本票收口时剩余领域（订阅生命周期、AI 额度账本、客户订阅体验、授权语料、运营面板补全、商业指标与实验）由下文 Decision 汇总为分阶段实施规格，按阶段再拆实施票。

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

所有产品与架构决定关闭后，如何拆成 schema、控制面服务、平台内容服务、智能体、前端订阅体验和运营面板的实施任务与发布顺序？

## Dependencies

- [`持续采集公开案例、更新中国大陆法规并建立法条关联`](12-legal-content-ingestion.md)

- [`定义 Plus / Pro / Max 的可完成工作与权益矩阵`](02-plan-outcome-entitlement-matrix.md)
- [`拆分内容访问、资源容量、AI 额度与功能能力`](03-entitlement-domain-model.md)
- [`定义工作区共享额度与不限席位的公平使用边界`](04-workspace-shared-allowance.md)
- [`设计平台法律内容目录、版本与授权生命周期`](05-content-catalog-licensing-lifecycle.md)
- [`设计智能体的授权语料解析与可核验引用`](06-agent-authorized-corpus-retrieval.md)
- [`确定试用、预览和专业模块推荐路径`](07-trial-preview-module-discovery.md)
- [`确定升级、降级、到期与历史成果语义`](08-subscription-content-lifecycle.md)
- [`设计运营面板的人工控制、解释与审计能力`](09-operator-control-plane.md)
- [`设计套餐价格验证与单位经济实验`](10-pricing-validation-unit-economics.md)

## Expected decision

- 形成阶段化实施规格、跨模块契约、迁移策略和验收条件。
- 明确哪些能力属于首发、后续专业模块和企业能力。
- 给出依赖顺序、风险门禁、灰度策略和回滚点。

## Captured implementation constraints

- 运营端采用独立根目录 `ops/`，参照 `marketing/` 的独立应用组织方式；框架可独立选择，包管理仍用 pnpm workspaces。
- 后端运营入口集中于 `server/src/ops/`，复用现有 quota 领域服务与平台运营能力校验。
- 从现有 `QuotaOperationsScreen` 迁移已实现功能，补纯运营登录和全部工作区分页目录；验收完成后退役客户前端旧运营入口。
- 数据维护采用已确认的 MCP-first 流程：本地 agent 采集清洗成品，服务端通过窄工具接收、校验和发布；首期不交付服务端通用爬虫或完整清洗审核页面。具体契约由 12 号任务提供。
- 首期 MCP 工具范围已确认：`get_data_contract`、`search_content`、`submit_batch`、`inspect_batch`、`publish_batch`；覆盖版本化契约、幂等提交、校验差异及固定批次发布，不开放任意生产库查询或 DDL。
- MCP 必须实现 OAuth 授权、受众验证和平台运营资格/能力复核；验收包含普通客户拒绝、无 workspace 运营登录、运营禁用后旧 token 拒绝、错误受众拒绝、批次部分发布与幂等重试。
- 用户明确将 OAuth 动态客户端注册（DCR）列为首期必做，需拆出 ma_hono 跨仓任务：面向 MCP 的受限注册、第三方 consent、resource/scope 处理及回调验证；原管理注册接口不直接开放。验收以未预注册的 Codex 从 MCP URL 自动接入为准。
- 内容 schema 按已确认的法规、案例和维护流程三组逻辑实体设计，并复用既有内容目录。MCP 整份提交法规/文书，服务端拆分法条与引用关系；客户端不依赖内部表名或数据库 ID。
- MCP 五工具同时覆盖新建/修订、撤回和恢复：批次条目携带操作意图，经检查差异后发布；验收覆盖过期版本前提拒绝、重复执行幂等、撤回后停止服务、恢复前重新核验，以及历史引用不被静默覆盖。

## Source audit

已落地（main 上可查）：

- `_system` 商业权威模型：`billing_account` / `billing_account_member`、`quota_subscription` / `quota_subscription_item`、`product_plan` / `product_plan_revision`（聚合 resource / content / ai / feature 四类不可变 template revision）、`content_collection` / `content_grant`、审计与通知 outbox（`shared/sql/system/004`、`021` 等）。
- quota 领域服务全套：`server/src/quota/`（entitlement-resolver、materialization、lifecycle sweep、alerts、notification outbox、migration conductor、ops console）。
- 产品权益聚合：`server/src/product-entitlement/`（resolve / service / store）。
- 平台内容库：`server/src/content/`（collection catalog、reader session / exchange / projection、legacy migration）与 `shared/src/platform-content/` 契约。
- 运营侧：`ops/` 独立应用、`server/src/ops/`（operator auth、MCP）、`scripts/platform-content-runner.ts` 本地 runner；SCK-LCM-01～10 与 ma_hono IDP-OM-01～03 已拆票并按 12 号定稿推进。
- 内容迁移：`#29` 隔离内容库已在 main，发布时经 `scripts/deploy/origin-pre-start.sh` 执行 `content:migrate --writes-frozen`（只复制校验，不删旧数据）。

明确缺口（本规格覆盖）：

- 04 号的 AI 额度账本尚无 schema 与服务：`metered_action_catalog`、credit bucket、原子预留 / 结算、四通道预算均未建表。
- 07/08 号的试用与生命周期 UX 未实现：当前仍是"创建 workspace 自动 trial"，无 billing account 试用资格、显式启动、保留模式界面与升降级流程。
- 06 号授权语料 Module 的双会话、证据注册表、可核验引用未整体落地（平台内容读取底座已有）。
- 09 号 handoff 列出的实施项未完成：`ops_anomaly` 等异常告警链路、全工作区分页目录、`QuotaOperationsScreen` 退役。
- 10 号的商业事件埋点、用量聚合与假门价格页不存在；schema 中无价格字段（按 10 号决定，价格引入时必须走不可变 revision）。

## Decision

### 1. 领域 → 实施对象映射

| 领域 | 决定来源 | 主要实施对象 | 现状 |
|---|---|---|---|
| 商品与计费单位 | 01 | product_plan key `lawyer_plus` / `lawyer_pro` / `lawyer_max`、按 workspace 订阅 | schema 就绪，待发布正式 plan revision |
| 权益模型 | 03 | `workspace_product_entitlement` 聚合快照、四域合并规则、provenance | resolver 已建，聚合快照接入待补 |
| 共享 AI 额度 | 04 | `metered_action_catalog`、credit bucket、原子预留 / 结算、通道预算、耗尽 UX | **未实现**，P1 |
| 内容目录与授权 | 05、12 | 内容库、滚动授权、许可交集、MCP 维护链路 | 底座已建（LCM 簇），真实来源试点在途 |
| 授权语料检索 | 06 | Authorized Corpus Module：双会话、证据注册表、可核验引用、未授权推荐触发 | **部分**，P3 |
| 试用与发现 | 07 | Discover 预览、billing account 试用资格、显式 7 日 Pro 试用、推荐卡片 | **未实现**，P2 |
| 订阅生命周期 | 08 | 到期保留模式、升降级存量语义、AI 额度桶生命周期、导出边界 | 生命周期 sweep 已有，产品语义接入 P1/P2 |
| 运营面板 | 09 | ops/ 视图（工作区目录、详情、计费账户、权益解释、异常）、动作集、能力矩阵 | 部分已建，补全 P4 |
| 定价与单位经济 | 10 | 成本核算口径、商业事件埋点、假门页、实验执行 | **未实现**，P4/P5 |

### 2. 首发范围与后置

首发（P1–P4 完成即具备"可收费前全功能"状态）：

- Lawyer Plus / Pro / Max 三档不可变 plan revision（额度数值先用 10 号实验前的内部占位 revision，不以占位数值对外销售）；
- 工作区级共享 AI 额度账本与耗尽 / 告警 UX；
- Discover 预览 → 显式 7 日 Pro 试用 → 订阅转换 → 保留模式完整链路；
- 授权语料检索与可核验引用；
- 运营面板全量视图与动作集；
- 工作区级商业事件与用量指标采集。

后置（不属于首发承诺）：

- 专业实务模块的销售与独立毛利核算（待真实需求信号，走 03 的 `professional_module_assignment`）；
- API/MCP 与 batch 通道的对外商业定价（客户侧机器通道先做预算隔离，不先定价）；
- 支付供应商集成、真实收款、发票 / 退款（依赖老板拍板，见 §7）；
- 企业合同、SLA、定制数据许可（Max 能力先行，合同流程后置）。

### 3. 分阶段发布顺序

**P0｜已交付 / 待发布收尾**

- SCK-LCM-01～10（本仓）与 IDP-OM-01～03（ma_hono）：内容 MCP 维护链路、独立 ops 应用、OAuth/DCR。
- `#29` 隔离内容库 + `origin-pre-start.sh` 迁移钩子：随上线申请批准后发布。
- 验收：LCM-10 端到端验收记录；#29 发布后 `/health` 与内容读取实测。

**P1｜商业底座补齐（schema + server）**

- 建 AI 额度账本：`metered_action_catalog`（版本化 rate revision）、credit bucket（套餐周期 / 购买 / 补偿）、原子预留与结算、消费顺序、interactive / employee / api_mcp / batch 四通道预算、50/80/100 告警接通既有通知 outbox。
- `quota_subscription_item` → `product_plan_revision` 绑定收尾；trial eligibility 归 billing account（同一账户同时仅一个有效自助试用）。
- 依赖：03/04 已收口；schema 增量走 `shared/sql/system/` 新版本号。
- 验收：额度耗尽前拒绝外部调用、失败全额释放、幂等重试不重复扣减、负余额不可达的测试与 reconcile sweep。

**P2｜客户订阅体验（web）**

- Discover 公开预览页（只用许可批准的 discover projection）；"开始 Pro 试用"显式启动（原子创建 workspace + trial subscription + 权益）；套餐选择 / 升级 / 降级 / 到期保留模式界面（不简写为"只读"）；额度余额与来源桶展示；推荐卡片（07 §7 单下一步结构）。
- 依赖：P1 的 trial eligibility 与额度账本对外 DTO。
- 验收：试用启动前展示范围与不含项；到期进入保留模式而非删除；试用转任意档不原地改 trial revision。

**P3｜授权语料与智能体**

- 06 号 Module 收口：执行窗口双会话（caller + corpus reader）、授权解析顺序、双语料检索排序、证据注册表、固定版本引用、未授权内容触发套餐 / 模块推荐。
- 依赖：P0 内容库 + P1 权益快照供给 current entitlement。
- 验收：未授权内容不进入模型上下文；引用可回溯到固定内容版本；推荐触发五条件齐全才展示。

**P4｜运营面板补全 + 商业指标**

- 09 handoff 实施项：`ops_anomaly` 表与通知 outbox 放宽、全工作区分页目录、权益解释视图、`QuotaOperationsScreen` 客户前端入口退役（放本阶段最后）。
- 10 §4 指标：`_system` 侧商业事件与聚合用量采集（preview / trial / conversion / metered action × channel / quota utilization / partial-locked 命中率），遵守不存原始法律问题的保密口径。
- 依赖：P1–P3 产出的事件源。
- 验收：运营可对任一工作区解释每项有效权益的来源与有效期；异常告警可 acknowledged。

**P5｜商业验证与定价引入**

- 执行 10 §3 的 E1–E5（访谈名单与试点客户由老板对接）；假门页上营销站需合规文案审核。
- 定价数字经老板拍板后，以新不可变 revision 引入；存量订阅按 10 §5 兼容原则不受影响。
- 验收：实验记录归档（区间假设、登记率、试点使用分布）；毛利模型用试点实测成本校准。

### 4. 跨模块契约（实施时不可违背）

- `workspace_product_entitlement` 聚合快照是运行时唯一权益权威；内容与功能在新 snapshot 发布后生效，在途请求固定开始时的 revision（03）。
- 内容访问 = 套餐内容 ∪ 专业模块 ∪ 临时 grant，并与来源许可取交集；discover 只用单独 projection（05/07/12）。
- AI 计量全部经 `metered_action_catalog` 版本化 rate revision；调用外部服务前原子预留，未交付可用结果全额释放；不向用户暴露 token（04）。
- 商业事件统一携带 workspace、billing account、plan key + revision、action key / channel、结果、时间戳；按工作区聚合，不按席位（10）。
- 内容维护只走 MCP 五工具契约 v1（LCM-01 冻结）；批次条目带操作意图，发布绑定审阅修订与版本前提（12 / Captured constraints）。
- 运营动作只创建版本化 grant / override / intent，禁止直改当前快照；全部落 `_system` 审计（03/09）。

### 5. 迁移策略

- 存量 quota-only workspace：由 conductor 复用 `quota_migration_*` 能力分配默认 `product_plan_revision`（旧 trial → trial revision；手工授权 → 对应 contract/manual 来源），先灰度 cohort 再全量；迁移只新增绑定与快照，不改写或删除生产数据（对齐 project.redLines）。
- 平台内容：沿用 #29 方案——复制 + 校验，不删 `_system` 旧数据，`content:migrate --writes-frozen` 经 `origin-pre-start.sh` 在停写窗口执行。
- 权益模型切换期间资源域仍以 `resource_entitlement` / quota projection 为准；聚合快照暴露 pending/applied 差异，不得宣称未下发容量已生效（03 §5）。
- 旧运营入口 `QuotaOperationsScreen` 保留至 P4 验收完成再退役，保证运营连续性。

### 6. 风险门禁、灰度与回滚点

风险门禁（不达标不进入下一阶段）：

- P1 额度账本：并发预留不产生负余额、退款回原桶、到期桶不可复活的测试与 sweep 证据。
- P2 试用：billing account 唯一有效试用由 `_system` 权威判定，客户端不可绕过。
- P3 语料：未授权内容进入模型上下文的回归测试必须为零泄漏。
- P4/P5 假门与价格：合规文案（明示未开售）与老板定价批准为硬门禁。
- 内容来源：许可交集不满足时停止该来源获取 / 提交 / 发布（12 准入规则）。

灰度策略：

- 产品权益切换按 `quota_migration_cohort` 分批；先内部 / 测试工作区再全量。
- 内容来源按准入逐来源开启，不一次放开全部候选。
- 新计量动作上线先按 channel 限速观察成本，再放开。

回滚点：

- 每阶段发布前记录上一 Quality gate 通过 sha；应用层回滚走 project.rollback（Actions 手动 Deploy 指定 sha）。
- schema 迁移只新增不回滚；权益快照不可变意味着任何错误授权通过发布新 revision 纠正，不需改历史。
- 假门页与指标埋点可经配置开关整体关闭；关闭不得影响核心订阅链路。

### 7. 待老板拍板与留给后续

- 待老板拍板：Plus / Pro / Max 价格与折扣、毛利门槛确认、试点 / 访谈名单与接触、真实收款启用（连带支付供应商签约）——同 10 §7。
- 留给后续：各阶段按本规格由经理拆具体实施票；价格字段引入时的 schema 形态沿用不可变 revision；支付供应商、发票、税务仍属 PRD out of scope。
