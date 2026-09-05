Status: open
Label: ready-for-agent

# 平台法律内容 MCP 与独立运营端实施规格

## 目标与范围

交付本地 agent 采集清洗、OAuth MCP 提交校验、运营确认发布的最小闭环。客户正文仍由平台内容数据库受控服务；运营端独立于客户 web。此次拆分聚焦内容维护、运营入口和 OAuth，不宣称已拆完行业订阅、客户研究体验或定价所有实施项。

## 规格来源

- [决策地图](../legal-data-product-wayfinder/PRD.md)
- [12 号已确认流程](../legal-data-product-wayfinder/issues/12-legal-content-ingestion.md)
- [数据契约草案](../legal-data-product-wayfinder/research/content-contract-v1.md)
- [schema 结构草案](../legal-data-product-wayfinder/research/content-schema-v1.md)
- [官方样本与限制](../legal-data-product-wayfinder/research/legal-content-samples.md)
- [IdP 核查](../legal-data-product-wayfinder/research/idp-mcp-oauth-readiness.md)
- [IdP 跨仓任务](/Users/y/IdeaProjects/ma_hono/.scratch/ops-mcp-oauth/PRD.md)

已确认决策优先于历史候选方案。字段/物理 schema 与真实全文往返尚未验证，在 01/02 票内落实；不能把草案当作现有实现。

## 首期锁定

- 五工具：get_data_contract、search_content、submit_batch、inspect_batch、publish_batch。
- 同五工具处理新建/修订、部分发布、撤回、恢复；每次发布绑定审阅修订、具体条目与版本/发布状态前提。
- OAuth + DCR 必须首期交付；只允许有效平台运营按自身能力维护。Codex 不持数据库 root 或 IdP 管理凭证。
- ops/ 独立 pnpm workspace 与构建部署；server/src/ops/ 管入口，内容规则集中 server/src/content/，shared/ 存框架无关契约。
- 新站点通常由本地采集逻辑适配；服务端只要求既定数据格式及已核验来源配置。
- 同一 issuer 可用不同 clientId，纯运营不需要客户 workspace；不通过 _system 数据库管理权限补登录。
- 默认人工审阅后发布，OAuth 同意不代替具体批次审阅。长期无人值守发布不在首期。
- 不改原生配额语义，不自动回收用户数据，不把平台全文写入客户 workspace。
- 本轮无新增 SurrealDB fork 功能任务；若受限发布权限在当前引擎无法实现，02 票先报告复现与设计阻碍，不擅自扩大 fork 改造。

## 路线图

| ID | 任务 | 本仓依赖 |
|---|---|---|
| SCK-LCM-01 | [冻结成品数据与五工具契约](issues/01-contract-fixtures.md) | 无 |
| SCK-LCM-02 | [建立平台内容库与受限维护身份](issues/02-content-schema.md) | SCK-LCM-01 |
| SCK-LCM-03 | [统一运营身份与数据维护授权](issues/03-operator-auth.md) | SCK-LCM-02 |
| SCK-LCM-04 | [建立独立 ops 应用并迁移已有配额运营台](issues/04-ops-app.md) | SCK-LCM-03 |
| SCK-LCM-05 | [实现成品接收、去重与不可变校验](issues/05-batch-validation.md) | SCK-LCM-01, SCK-LCM-02, SCK-LCM-03 |
| SCK-LCM-06 | [实现部分发布、纠错、撤回和恢复](issues/06-publication.md) | SCK-LCM-05 |
| SCK-LCM-07 | [交付 OAuth 保护的五工具 MCP](issues/07-mcp-oauth.md) | SCK-LCM-03, SCK-LCM-05, SCK-LCM-06 |
| SCK-LCM-08 | [补来源登记、批次状态与审计入口](issues/08-source-audit-ui.md) | SCK-LCM-04, SCK-LCM-05, SCK-LCM-06 |
| SCK-LCM-09 | [提供本地采集与持续更新运行方案](issues/09-local-runner.md) | SCK-LCM-07, SCK-LCM-08 |
| SCK-LCM-10 | [完成 Codex 自动接入与内容生命周期验收](issues/10-codex-e2e.md) | SCK-LCM-04, SCK-LCM-07, SCK-LCM-08, SCK-LCM-09 |

07 与 10 还依赖 IdP 的 IDP-OM-01/02/03。

## 开工与顺序

1. 现在可开始 SCK-LCM-01 和 IDP-OM-01；两仓可并行。
2. 本仓沿 01 → 02 → 03 推进；03 后 04 运营前端与 05 入库可并行，05 后做 06。
3. IdP 沿 01 → 02 → 03；本仓领域服务与 IdP 就绪后完成 07。
4. 04/05/06 后做 08；07/08 后做 09；全部汇入 10 实测。
5. blocked 表示前置交付尚未完成，不表示等待新的用户决策。前置验收后切为 open/ready-for-agent。

## 发布门槛

- 测试先用临时内容库和允许使用的 fixture，不默认将公开网页变成可销售来源。
- 客户读取需要合法内容授权及许可投影；内容维护测试不等于已完成套餐权益或 AI 研究集成。
- 从未预注册 Codex 完成发现、注册、授权、五工具、重连/刷新、撤权；不以手工 token 绕过。
- 真实整份法规/文书、逐引用版本、部分发布、并发和失败恢复有测试证据。
- 生产部署、真实 client 配置及来源发布在 10 的发布清单中执行，不由建票自动完成。

## 暂不包含

完整可视化爬虫/清洗工作台、开放案例商城、付款 provider 选型、税票/退款编排、客户 AI/内容商业权益完整产品化。它们仍由原决策地图的其它任务处理。

