Status: in_progress
Label: wayfinding

# 律师行业订阅与平台法律数据产品决策地图

## Destination

形成一套可直接转入实施规格的律师行业订阅方案：用户只需选择 Plus、Pro 或 Max，不必理解或购买底层案例集；每个工作区统一获得内容访问、共享 AI 额度、自建数据容量和产品功能，工作区成员不设席位上限且共同消耗额度；平台内容可被智能体按授权检索、引用和持续更新，同时与用户自建数据保持权属、计量和修改边界。

地图完成时，套餐承诺、权益模型、内容供应与授权、智能体检索、试用转化、升级降级、运营控制和商业验证问题均已关闭，并能据此拆分 schema、后端、前端、智能体和运营面板实施任务。

## Notes

- 已生成 [内容维护 MCP 与独立运营端实施簇](../legal-content-mcp/PRD.md) 及 [IdP 跨仓实施簇](/Users/y/IdeaProjects/ma_hono/.scratch/ops-mcp-oauth/PRD.md)，合计 13 张票；其余产品实施拆分仍由 11 号跟踪。

- 本地图只做 wayfinding 和规格收敛，不在本阶段实现产品功能。
- 首期一级商品固定为 Lawyer Plus / Pro / Max；案例集是后台来源、版本和授权单元，不是首次购买入口。
- 按工作区计费。工作区成员不限制席位，共享内容访问、自建容量和 AI 额度；成员权限仍由现有 workspace 身份模型控制。
- Plus 必须提供有限案例能力，不能只销售公开法规和数据库容量；Pro 承担完整核心案例研究的主要价值；Max 承担治理、私有知识、集成和组织级能力。
- 对外不以 table、field、record 数量作为核心价值叙事；它们只作为“工作区容量”的详细规格和数据库原生硬限制。
- “持续更新”必须给出可兑现的更新频率、来源时间和勘误语义，不默认承诺无法证明的实时更新。
- 本地 Markdown tracker 没有原生 dependency/assignee API，因此子票用 `Assignee:` 与 `## Dependencies` 表达状态和阻塞关系。
- 市场研究位于 [`research/`](research/)；只引用官方公开资料，不推测未公开价格。

## Decisions so far

- [`确定订阅优先的一级商品与计费单位`](issues/01-subscription-first-packaging.md) — 首期只销售 Plus / Pro / Max，按工作区收费、不限制成员席位、共享额度；案例集隐藏为后台供应单元，专业实务模块后置。
- [`定义 Plus / Pro / Max 的可完成工作与权益矩阵`](issues/02-plan-outcome-entitlement-matrix.md) — Plus 完成日常法规与有限案例研究，Pro 提供完整核心类案研究，Max 提供组织治理与集成；三档均不限成员且不承诺无限资源。
- [`拆分内容访问、资源容量、AI 额度与功能能力`](issues/03-entitlement-domain-model.md) — 不可变产品套餐版本聚合四类子模板；工作区权益以可解释快照解析，资源、内容、AI 和功能分别采用适合自身的合并及执行语义。
- [`定义工作区共享额度与不限席位的公平使用边界`](issues/04-workspace-shared-allowance.md) — 普通访问不扣 AI 额度，高成本动作原子预留并按工作区共享结算；机器通道分别预算，首期不做自动充值、透支或商业公平使用系统。
- [`设计平台法律内容目录、版本与授权生命周期`](issues/05-content-catalog-licensing-lifecycle.md) — 平台内容进入独立内容数据库，以不可变内容版本和数据集发布管理；工作区通过滚动内容集合授权及短期读取会话访问，不复制或篡改平台全文。
- [`设计智能体的授权语料解析与可核验引用`](issues/06-agent-authorized-corpus-retrieval.md) — 深授权语料 Module 以双会话检索平台与私有资料，数据库内强制授权、运行期登记证据并固定精确版本引用；未授权内容不进入模型上下文。
- [`确定试用、预览和专业模块推荐路径`](issues/07-trial-preview-module-discovery.md) — Discover 不建免费 workspace；显式启动 7 日 Pro 受控试用，按计费账户限制一个有效试用，专业模块只在安全发现确认覆盖缺口时推荐；到期进入保留模式。

- [`确定升级、降级、到期与历史成果语义`](issues/08-subscription-content-lifecycle.md) — 不设宽限，到期直接保留模式；用户成果保留，平台原文按当前授权读取；AI 按独立额度桶到期与结算。

## Question frontier

- [`持续采集公开案例、更新中国大陆法规并建立法条关联`](issues/12-legal-content-ingestion.md) — 来源验证、真实样本、数据表结构及持续采集发布流程；先于实施规格收口。

- [`设计运营面板的人工控制、解释与审计能力`](issues/09-operator-control-plane.md) — 如何查看并调整计划、内容、容量和 AI 额度，同时保留来源、有效期和责任链？
- [`设计套餐价格验证与单位经济实验`](issues/10-pricing-validation-unit-economics.md) — 在不先拍脑袋定价的情况下，如何验证支付意愿、内容成本和 AI 毛利？
- [`汇总实施规格与分阶段发布顺序`](issues/11-implementation-spec-rollout.md) — 如何把已关闭决定转成 schema、服务、智能体、前端和运营面板的可交付计划？

## Not yet specified

- Plus / Pro / Max 的具体权益数值、价格、月付与年付折扣。
- 核心案例范围、专业实务模块边界及内容来源许可条件。
- 高成本 AI 动作的正式档位数值、周期额度与加量包价格。
- 平台内容的更新频率、撤回、勘误和历史引用展示规则。
- 虚拟员工、API/MCP 和批处理通道的正式预算及并发数值。

## Out of scope

- 本地图不选择支付供应商，不设计税务、发票、优惠券、退款或收单流程。
- 根据新增需求，本地图通过 12 号任务纳入来源可行性验证、数据结构和持续采集管线设计；生产采集部署留待实施阶段，具体许可条件必须逐来源验证。
- 首期不建设开放案例商城，也不要求新用户选择执业领域或案例集。
- 普通律师首期不采用纯按次、按 token、按行或按案例收费；API/MCP 和批量机器调用可在后续单独定价。
- 本地图不修改已经确定的 SurrealDB 原生 table、field、record 配额语义，只定义这些资源如何作为行业套餐的一部分呈现和授予。
