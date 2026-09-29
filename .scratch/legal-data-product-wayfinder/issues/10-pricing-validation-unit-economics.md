Status: done
Label: done
Assignee: product

# 设计套餐价格验证与单位经济实验

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

在不知道真实支付意愿、内容成本和 AI 使用分布时，如何验证 Plus / Pro / Max 的价格、额度和年付折扣，而不是直接拍板数字？

## Dependencies

- [`定义 Plus / Pro / Max 的可完成工作与权益矩阵`](02-plan-outcome-entitlement-matrix.md)
- [`定义工作区共享额度与不限席位的公平使用边界`](04-workspace-shared-allowance.md)
- [`确定试用、预览和专业模块推荐路径`](07-trial-preview-module-discovery.md)

## Expected decision

- 定义内容获取与维护成本、AI 边际成本、支持成本和目标毛利模型。
- 设计访谈、假门测试、试点、月付/年付和升级触发实验。
- 定义需要采集的工作区级使用与转化指标。
- 给出价格变更时既有客户和套餐版本的兼容原则。

## Source audit

- `_system` 已有 `billing_account`、`billing_account_member`、`quota_subscription`（含 `trialing` / `active` / `past_due` / `canceled` / `expired` 状态与 `provider_customer_id` / `provider_subscription_id` 字段）和 `quota_subscription_item`（绑定 workspace + revision + `effective_from` / `effective_until`），足以承载试用、合同与正式订阅。
- `product_plan` / `product_plan_revision` 与三类 template revision 均为不可变版本模型，源码注释明确"不写入正式集合、额度或价格"——当前 schema 没有价格、币种或支付字段，价格引入时必须沿用不可变 revision 模式。
- `provider_event_inbox` / `provider_event_state` 预留了外部 provider 事件通道，但首期不选择支付供应商（PRD out of scope），本任务不产生任何真实收费动作。
- AI 计量的执行侧已就绪：`metered_action_catalog`、额度桶、原子预留与 50% / 80% / 100% 告警阈值已由 04 号决定；试用与专业模块推荐路径已由 07 号决定。缺少的是"每个计量动作的实测成本"与商业转化指标。
- 当前没有面向定价实验的事件埋点；workspace 内已有 `activity_event`，`_system` 已有 `product_entitlement_audit` / `quota_audit_event`，指标口径需要在本任务定义后由实施任务落到具体表。
- 公开价格模式调研见 [`research/legal-product-pricing-models.md`](../research/legal-product-pricing-models.md) 与 [`research/vertical-data-saas-pricing-models.md`](../research/vertical-data-saas-pricing-models.md)，仅引用官方公开资料，不构成定价数字依据。

## Decision

### 1. 总原则：验证区间与结构，数字由老板拍板

- 本任务产出成本模型、实验设计、指标口径和兼容原则；不产出公开价目，不执行收费动作。
- 价格数字、年付折扣、试点名单、收款开关全部列为待老板拍板项（见第 7 节）。
- 实验的判别标准是"能否区分支付意愿与口头兴趣"：意向登记、访谈答案只作区间证据；试点真实使用数据才用于校准成本模型。

### 2. 单位经济模型（按工作区月度口径）

```
毛利/workspace/月 = 订阅价格
  − 内容摊销成本      （采集 + 许可 + 维护，按月摊到付费工作区）
  − AI 边际成本       （metered action 实测外部成本，非额度面值）
  − 支持成本          （onboarding + 咨询 + 人工运营工时折算）
  − 基础设施摊销      （SurrealDB 主机 / Cloudflare / IdP / 存储带宽）
```

四个成本桶的定义与计量口径：

- **内容获取与维护**：获取侧含来源许可费（若存在付费来源）、采集管道开发运行、一次性入库清洗；维护侧含持续更新采集、版本化存储、勘误、法条关联和来源合规复核。摊销口径为当月内容总成本 ÷ 当月付费工作区数；核心法规、核心案例、专业模块分别归因核算——专业模块因授权成本独立，必须单独算毛利，不得摊进核心内容池。
- **AI 边际成本**：每个 `metered_action_catalog` 动作按 rate revision 记录实测外部成本（模型调用、embedding、长上下文、外部检索），每月滚动重估。毛利分析只使用实测成本，不用额度面值；按 `interactive` / `employee` / `api_mcp` / `batch` 四通道分别统计，识别哪类通道侵蚀毛利。
- **支持成本**：每付费工作区月度支持工时 × 工时成本。访谈与试点阶段起记录真实工时校准，不拍脑袋估算。
- **基础设施摊销**：按付费工作区月均摊；单 workspace 一个 SurrealDB database 的结构使存储与连接成本可近似线性分摊。

目标毛利模型：

- 主决策指标为**贡献毛利率** =（价格 − AI 边际成本 − 支持成本）/ 价格；内容与基础设施摊销作为二级指标纳入完全毛利视图。
- 建议门槛（非承诺，待老板确认）：Pro 档贡献毛利率 ≥ 70% 为绿灯；50%–70% 需书面说明结构性原因；< 50% 触发定价或额度结构返工。依据：垂直数据 SaaS 毛利常模 70%+，AI 边际成本是主要不确定变量。
- 压力测试口径：模拟 P95 重度工作区耗尽全部 included 额度时的贡献毛利，若仍 ≥ 50%，说明额度设计安全；若为负，先调额度档位再测价格。

### 3. 实验组合与执行顺序

通用护栏：任何实验不产生付款义务、不收集支付信息、不做虚假紧迫感文案；假门页面必须明示"尚未开售"；试点与访谈接触真实客户由老板对接，员工不擅自外联。

**E1 支付意愿访谈（先行）**

- 对象：中小律所执业律师 / 主任、企业法务等目标画像。
- 方法：Van Westendorp PSM 四问（太便宜不可信 / 划算 / 偏贵但可考虑 / 太贵不会买），按 02 号三档权益矩阵分别问"为完成这档工作结果愿付多少"。
- 产出：各档可接受区间、最优价格点、"必须包含否则不买"清单。
- 规模：≥ 8 个有效访谈形成区间假设，不追求统计显著。
- 记录口径：只存结构化价格答案与角色画像，不记录案件事实与当事人信息。

**E2 假门价格页测试**

- 机制：营销站 / Discover 出口展示含价格的套餐页（价格取 E1 区间中点 ± 一档做 A/B 锚点），点击"订阅"进入"即将开放，留下通知方式"页。
- 指标：价格页到达率、各套餐点击分布、通知登记率，按展示价位分组对比。
- 护栏：页面明示未开售；登记≠成交承诺；不做"限时折扣"等虚假稀缺。

**E3 试点（design partner pilot）**

- 机制：运营人工为试点客户开通 `source = contract` 的 `quota_subscription`，试用等价权益、约定期限与退出条件；试点价（免费或象征性）由老板定。
- 目的：用真实使用校准单位经济——AI 动作分布与成本、内容覆盖率（partial / locked 比例）、quota 利用率、支持工时。
- 规模：3–5 个工作区，约定回访节奏。
- 边界：试点价不视为公开价；书面写明试点结束转正式定价需重新确认，避免锚定既成事实。

**E4 月付 / 年付实验**

- 机制：在 E2 假门与 E3 试点报价中并列展示月付价与年付价（年付折扣假设如"付 10 个月用 12 个月"），访谈中单独追问年付承诺障碍。
- 指标：年付选择率、折扣弹性、年付拒绝原因分布。
- 护栏：具体折扣数字仍属老板拍板，实验只测弹性与门槛。

**E5 升级触发实验**

- 机制：在试用 / Plus 工作区复用 04 号告警（额度 80% / 100%）与 07 号推荐卡片（内容 `partial` / `locked`、导出受限）展示升级或加购提示，记录意向点击与购买请求。
- 指标：提示曝光 → 意向点击 → 购买请求转化率，按触发类别（quota / content / feature）拆分。
- 护栏：提示可由运营面板开关并留审计；不夸大缺口、不制造虚假稀缺。

### 4. 需要采集的工作区级指标

存储原则：商业事件与聚合用量记录在 `_system` 权威侧；workspace 内明细仅在确有需要时落 `activity_event`；全程遵守 07 号保密约定——默认不保存原始法律问题、案件事实、文档摘录或模型上下文。

- **获取与转化**：preview viewed、trial offered / started / converted / expired、价格页曝光、套餐点击、通知登记、购买请求发起。
- **使用强度**（每工作区每账期）：metered action 消耗按 action key × channel 分布；额度消耗占 included 额度的比例；quota utilization（table / field / record 占配额比）；授权语料 partial / locked 命中率；研究与报告的复用 / 回访动作。
- **经济性**：每工作区月度实测 AI 成本、支持工单数与工时、内容摊销额——直接喂给第 2 节模型。
- **事件结构**：统一携带 workspace、billing account、plan key + revision、action key / channel、结果与时间戳；粒度按工作区聚合，不按成员席位（与不限席位模型一致）。

### 5. 价格变更与既有客户兼容原则

- **不可变 revision**：价格引入 schema 时只存在于不可变 plan / rate revision；变更 = 发布新 revision，绝不原地修改已发布 revision——与现有 immutable 模型一致，天然可审计。
- **周期内不变**：既有订阅绑定的 revision 在当前合同 / 账期内价格和权益都不变（grandfathering）；新价格只影响新购、续费和升级。
- **上调**：对存量客户设公告期（建议 ≥ 30 天）与当前周期保护；年付合同期内价格锁定；到期续费适用新 revision 或合同约定的续约价，订购时须已明示续费规则。
- **下调 / 促销**：不追溯已支付周期；是否作为续费价开放给存量客户由运营决定并记录。
- **试用价格一致性**：试用页展示的价格必须与转换时可实际获得的价格一致；试点 / 合同价以书面约定为准。
- **权益变化 = 新 revision**：套餐权益缩减不得对存量客户当前周期生效；存量订阅保留原 revision 直到续费或自愿迁移。
- **外部成本传导**：币种、税、支付供应商费用变化不静默转嫁，需新 revision 并公告。
- **审计**：所有价格 / revision 变更与兼容决策落 `_system` 审计（`product_entitlement_audit` / `quota_audit_event`）。

### 6. 明确留给后续任务

- 商业事件与用量指标的具体 schema 与采集管道（`_system` 事件表或扩展 `activity_event`）由 11 号实施规格承接。
- 假门价格页的实现、A/B 分流机制和"尚未开售"合规文案在实施阶段细化。
- 支付供应商选择、税务、发票、退款仍属 PRD out of scope。
- 额度档位数值、加量包面值随定价实验结果一并由 11 号落定。

### 7. 待老板拍板项（本任务不执行）

- Plus / Pro / Max 公开价格数字、月付 / 年付折扣、加量包定价与计量面值。
- 第 2 节建议的毛利门槛（70% / 50%）是否采纳为正式红线。
- 试点客户名单、接触方式与试点价格（免费或象征性）。
- 访谈对象的对外联系安排。
- 是否及何时启用真实收款（连带支付供应商签约）。
