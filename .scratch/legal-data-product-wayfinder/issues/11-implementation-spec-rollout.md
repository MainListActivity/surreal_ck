Status: in_progress
Label: planning
Assignee: unassigned

# 汇总实施规格与分阶段发布顺序

## 已拆出的实施簇

- [平台法律内容 MCP 与独立运营端](../../legal-content-mcp/PRD.md)：SCK-LCM-01 至 10，覆盖契约、内容库、运营身份、独立 ops、校验发布、MCP、本地 runner 和端到端验收。
- [ma_hono OAuth / DCR](/Users/y/IdeaProjects/ma_hono/.scratch/ops-mcp-oauth/PRD.md)：IDP-OM-01 至 03。
- 可立即开始 SCK-LCM-01 与 IDP-OM-01，其余按任务依赖解锁。
- 本次先完成用户当前要求的内容维护链路拆分；完整行业订阅、客户授权研究体验与价格实验尚未全部转实施票，因此本票不标 done。

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
