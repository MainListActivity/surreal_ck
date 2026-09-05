# 数据产品 / 垂直 SaaS 定价与包装模式研究

> 调研日期：2026-08-30  
> 范围：仅使用厂商官方定价页、帮助中心、产品页或正式协议。价格与权益会变化，文中数字用于识别包装模式，不构成 surreal_ck 的最终定价。

## 结论先行

对 surreal_ck 最容易理解、也最适合首发的不是“用户先挑案例集”，而是一个**律师行业订阅**：客户购买 Plus / Pro / Max，套餐同时包含持续更新的法律内容、案例研究能力、AI 查询额度、团队席位和自建数据库容量。数据集继续作为平台内部的来源、版本和授权单元，不成为一级商品。

推荐商业结构：

1. **固定订阅费是主价格**：承载行业内容、产品功能和一组明确的自建容量；用户不必先理解某个案例集。
2. **套餐之间按结果能力分层**：Plus 能持续跟踪法律并完成基础案例研究；Pro 解锁完整案例覆盖、带引证 AI 研究和团队协作；Max 面向多团队、治理、API/批量能力和专业内容。
3. **AI 是套餐内含额度 + 共享加购包**：高成本深度研究才消耗 credits；普通检索、浏览已有答案和访问已授权内容不重复收费。
4. **自建 table / field / record 是套餐权益，不是卖点标题**：在价格页作为“工作区容量”展示；达到硬限额时提示升级，不对行数做意外超额扣费。
5. **席位采用“含基础人数 + 额外执业席位”**：只对能使用 AI、创建/编辑数据的活跃成员收费；只读成员和外部分享不收费或低价。
6. **专业内容加购延后**：首发避免案例商城。未来对成本高、授权独立或极专业的内容，才增加“专业数据模块”，并由系统基于问题推荐。
7. **月付降低试用门槛，年付换取折扣和承诺**；大型律所再走年度合同、集中 credits、审计、SLA 和定制数据范围。

这个结构并不奇怪，反而同时借鉴了法律数据库、数据 SaaS 与 AI 工作区的成熟模式：法律内容按订阅持续交付，软件容量随套餐提升，AI 高成本使用由可控的 credits 承接。

## 一手案例

### 1. Airtable：席位订阅 + 数据容量 + 套餐内 AI credits + credits 加购

Airtable 是与 surreal_ck 资源结构最接近的参照：套餐按席位收费，同时逐级提升 record、API、附件和历史容量。其官方套餐说明显示：Free 每个 base 1,000 records；Team 为 50,000 records，并按 workspace 内跨表累计；每个 base 还存在 1,000 tables、每表 500 fields 的结构上限。达到 record/attachment 上限后，Airtable 不删除数据，但禁止继续添加，直至升级。[Airtable plans overview](https://support.airtable.com/articles/2277136852-airtable-plans-overview)；[Airtable pricing](https://airtable.com/pricing)

其 AI 采用第二层计量：各套餐按付费协作者每月贡献一定 credits，credits 在 workspace / organization 中共享；额度用尽后可购买 10,000 至 400,000 credits 的月度或年度包。AI 问答、网页研究、文档分析按动作复杂度消耗不同 credits，而搭建应用不耗 credits。[Airtable AI billing](https://support.airtable.com/articles/3378106230-airtable-ai-billing)

**可借鉴：**

- table / field / record 配额自然地作为套餐容量存在，不需要单独销售。
- 团队获得共享 AI 池，比逐个律师购买问答次数更容易管理。
- 超出数据容量后“保留、可读、禁止新增”的策略，与 surreal_ck 原生配额的降级语义一致。
- 只读协作者不计费，适合律师团队让助理、客户或外部顾问查看成果。

**风险：** 如果同时把席位、records、API 和 credits 都放到价格页主视觉，用户会面对过多计量轴。surreal_ck 应把 records/fields/tables 折叠为一个“工作区容量”指标，详细数字进入比较表。

### 2. Crunchbase：实时数据 + AI 助手 + 免费试用 + 导出限额

Crunchbase Pro 将“持续更新的私营公司数据”、搜索、自动提醒、AI assistant 组合为单一订阅。官方购买页提供 7 天免费试用，并按席位、按年计费；官方产品页强调 4M+ 公司、自动提醒以及每月最多导出 2,000 行。Business 在 Pro 基础上增加预测、组织级集成与情报能力。[Crunchbase Pro purchase](https://www.crunchbase.com/buy/cb-pro)；[Crunchbase Pro product](https://about.crunchbase.com/products/crunchbase-pro)

官方帮助中心同时提供更高价的月付 Pro，定位为可随时取消、适合短期项目的灵活选择。[Crunchbase monthly subscription](https://support.crunchbase.com/hc/en-us/articles/360001618747-Is-there-a-monthly-subscription-option-for-Crunchbase-Pro)

**可借鉴：**

- 用户买的是“行业情报能力”，不需要知道背后的数据集边界。
- 持续更新、保存检索和自动提醒本身就是订阅续费理由；法律法规变更、案例新增和关注主题提醒可扮演同样角色。
- 可访问数据与可批量导出数据是两种权益。surreal_ck 可以允许订阅内检索和引用大量案例，但限制批量导出，保护数据资产。
- 低摩擦试用证明内容覆盖；导出等高泄露风险能力可在试用期关闭。

**风险：** 用“多少案例”作为唯一升级理由，会诱导数量竞赛。法律产品更应展示覆盖范围、更新时效、标注深度、可验证引证和工作流结果。

### 3. Westlaw / Lexis+：内容范围、AI 能力、席位和专业模块决定价格

Westlaw 官方把产品分为基础研究、AI-Assisted Research、Deep Research 与 CoCounsel 工作流组合；AI 回答直接链接权威来源，并用 KeyCite 等持续状态信息支持验证。[Westlaw plans](https://legal.thomsonreuters.com/en/westlaw/plans-and-pricing)；[Westlaw Edge with AI-Assisted Research](https://legal.thomsonreuters.com/en/products/westlaw-edge)

Westlaw Patron Access 展示了清晰的“平台费 + 内容模块”结构：每个计划从本州 cases、statutes、KeyCite 和分析材料等核心内容开始，可从数百个可选模块定制；合同期内按内容和终端数形成可预测月费，授权范围外不能意外产生费用。[Westlaw Patron Access](https://legal.thomsonreuters.com/en/products/westlaw/patron-access)

Lexis+ 官方说明其价格受组织规模、执业领域 / jurisdiction、premium content 与 analytics、席位数影响；小所可在线选购，大中型组织走定制报价。Lexis+ 把生成式 / agentic AI 建立在法律内容订阅之上，而不是把 AI 与权威内容拆成无关商品。[Lexis+ product and pricing factors](https://www.lexisnexis.com/en-us/products/lexis-plus.page)

**可借鉴：**

- 法律客户已经习惯“法律内容 + 更新 + 检索 / AI 工具”的订阅，而非逐个案件购买。
- Plus / Pro / Max 可以按内容覆盖和研究工作流分级，同时让每层都有可独立完成的价值。
- 未来可为独立授权、昂贵或高专业度内容采用 add-on，但 core cases / statutes 应属于主订阅。
- AI 输出必须能回到具体法律权威；“带引用、可验证”应是核心价值，而不只是 usage 配额。

**风险：** 过早复制 Westlaw 的数百模块会把发现问题转嫁给客户，也会制造复杂销售和 entitlement 矩阵。首期应保留最多三档主套餐，专业模块只在真实需求和独立成本成立时出现。

### 4. Bloomberg Law：一价全包、无限使用和持续创新

Bloomberg Law 官方以“一平台、一价格”包装 primary / secondary sources、新闻、分析和 AI workflow tools，强调 complete / unlimited access、无需为不同工具支付 upcharge。[Bloomberg Law legal research](https://pro.bloomberglaw.com/products/legal-research-and-software/legal-research/)；[Bloomberg Law platform](https://pro.bloomberglaw.com/products/legal-research-and-software/)

**可借鉴：**

- 当用户很难预测自己会查哪个案例集时，全包内容能显著降低选择成本和账单焦虑。
- 平台持续加入法律更新、分析和工具，是订阅续费的价值承诺。
- 对首期 surreal_ck，Pro 可承担“一价获取完整核心案例研究”的锚点，而不是让用户逐包购买。

**风险：** 对 AI 深度研究也完全不限量，会让成本和滥用不可控。因此可对“内容检索 / 浏览”采用无限或公平使用，对高成本 agentic runs 使用套餐内 credits。

### 5. 北大法宝：按库购买 + AI 体验赠送

北大法宝官方购买页将法律法规库、司法案例库、法学期刊库、律所实务库和专题参考库作为可线上购买产品；官方站点还展示“买 1 个库赠 1 套法律智能辅助套装体验 30 天、买 2 个库体验 60 天”等组合。[北大法宝产品与服务](https://www.pkulaw.com/BuyBdfb/63.html)；[北大法宝 V6](https://www.pkulaw.com/searchall)

**可借鉴：** 中国法律客户对“按库授权、附带智能工具”并不陌生；这证明专业数据 add-on 有市场语义。

**风险：** 这也是 surreal_ck 当前困惑的直接来源：不知道该买哪个库的用户仍需理解内容目录。对 surreal_ck，更好的做法是把法律法规与核心案例纳入行业套餐，仅将极专业或独立授权内容做 add-on，并让智能体在用户表达问题后推荐，而不是先展示数据库货架。

### 6. ChatGPT Business：固定席位基线 + included usage + workspace credits + spend control

ChatGPT Business 官方采用固定每用户订阅，标准席位包含基线访问；超过 included limits 后，可从 workspace 共享 credits 继续使用高级能力。Workspace owner 可购买 credits、设置自动充值、usage alerts 和 spend limits；年度席位价格低于月付，新增席位按周期 prorate / true-up。[ChatGPT Business billing](https://help.openai.com/en/articles/8792536-manage-billing-on-the-chatgpt-business-subscription-plan)；[Flexible pricing](https://help.openai.com/en/articles/11487671-flexible-pricing-for-chatgpt-enterprise-plans)；[Business credits and spend controls](https://help.openai.com/en/articles/20001155)

**可借鉴：**

- 固定订阅消除日常使用焦虑，credits 只负责超出基线的高成本行为。
- 共享池、告警、自动充值和上限是运营面板必须支持的控制面。
- 团队可混合不同席位能力；surreal_ck 后期可区分执业律师席位与查看 / 协作席位。

**风险：** credits 如果直接暴露 token 或模型成本，律师难以预测。surreal_ck 应把计量单位设计为可理解的“快速问答 / 深度研究 / 文档分析”，并在执行前显示预计消耗。

### 7. Snowflake：按量与年度 capacity contract 并存

Snowflake 的官方 credit consumption table 同时存在 on-demand credit price 与 capacity credit pricing；capacity discount 由 Order Form 约定，并与承诺规模关联。[Snowflake Credit Consumption Table](https://www.snowflake.com/legal/creditconsumptiontable-2/)

**可借鉴：** 企业客户可在年度合同中预购共享使用池获得折扣，适合大型律所、律协或机构采购。

**风险：** 纯按量计费把成本不确定性推给律师团队，不适合 surreal_ck 的自助首发。它应只用于超大客户或 API / 批处理等机器使用场景。

## 六种包装模型的适用性

| 模型 | 典型案例 | 优点 | 缺点 | 对 surreal_ck 的建议 |
|---|---|---|---|---|
| Tiered bundle | Airtable、Westlaw | 简单、可自助、升级路径清晰 | 套餐差异过多时会变成对照表迷宫 | **首发主模型**，只保留 Plus / Pro / Max |
| Seat + usage | Airtable AI、ChatGPT Business | 收入随团队与高成本 AI 使用增长 | 双重计费易引发不信任 | 用“含基础席位 + included AI + 共享加购” |
| Platform fee + data add-on | Westlaw Patron Access、北大法宝 | 可覆盖独立授权成本与专业需求 | 用户不知道该选哪个库，entitlement 复杂 | **后期辅模型**；系统按问题推荐，最多少量模块 |
| Freemium / preview | Crunchbase | 降低购买前不确定性 | 泄露数据价值、吸引低意向流量 | 元数据 / 覆盖预览 + 7 天受控试用，不开放批量导出 |
| Credits / overage | Airtable AI、ChatGPT Business、Snowflake | 对齐可变成本，可支撑重度用户 | 难预测、可能形成账单焦虑 | 仅计高成本 AI / API；数据行达到上限则升级或停写 |
| Annual contract | Lexis+、Snowflake | 收入可预测，适合采购和定制 | 销售周期长，权益容易分叉 | Max / Enterprise 使用，保留标准 entitlement 模型 |

## 对 surreal_ck 的推荐套餐骨架

下面是包装结构，不是最终数字或价格。

### 免费体验 / Discover

- 用户可用自然语言描述法律问题并完成研究范围澄清。
- 可浏览法律更新标题、案例元数据、覆盖范围和少量示例引用。
- 提供 7 天受控试用或有限次数的带引用研究；禁止批量导出。
- 给一个很小的私有工作区容量，用于体验“自己的数据 + 平台数据”联合查询。

### Plus：律师工作台

- 持续更新的现行法律法规、效力状态、变更提醒。
- 核心司法案例检索与有限的案例全文 / 引用研究，不应完全没有案例能力。
- 基础 AI 问答和少量深度研究额度。
- 一定数量的执业席位、只读成员，以及明确的 table / field / record 容量。
- 目标：个人律师或小团队能完整完成日常研究和案件资料管理。

### Pro：案例智能研究

- 完整核心案例覆盖、平台整理 / 标注、相关案例与裁判规则追踪。
- 带出处的 AI 研究、跨案例比较、用户材料与平台案例联合分析。
- 更大的共享 AI 池、自建容量、历史版本和团队协作。
- 目标：案件密集型团队将 surreal_ck 作为主要案例研究与工作空间。

### Max：组织级法律数据平台

- 全部核心内容；经商业验证后可包含若干专业内容模块或 credits 额度。
- 更高容量、更多席位、审计、使用分析、细粒度数据访问控制、SLA。
- 可选 API、批量导出、私有数据接入、年度共享 credits 和定制授权。
- 目标：中大型律所、企业法务、机构客户。

## 关键产品决策

### 不建议 Plus 只有法律条款、Pro 才第一次获得任何案例

法律条款本身大多可从公开渠道免费获得；如果 Plus 只有原始条文和自建表容量，其付费理由弱，也无法让用户在真实工作中感受到案例智能。建议 Plus 至少包含**核心案例检索、有限全文或每月若干次带引用研究**，Pro 再通过完整覆盖、持续标注、跨案例分析和更高 AI 配额形成明显升级。

真正可收费的“实时法律条款”不是文本本身，而是：

- 新旧版本、效力状态和沿革；
- 与用户业务 / 案件相关的变更监测；
- 法条与案例、司法解释、实务指引的关联；
- 变化的影响摘要和待办提醒；
- 可核验的来源与更新时间。

### 内容访问权、自建容量和 AI 使用必须是三个独立 entitlement 轴

价格页可以把它们打包，但底层不可用一个“plan = pro”硬编码：

- **Content entitlement**：能访问哪些法规、案例、标注和专业内容；
- **Workspace quota**：可创建多少 table / field / record，以及存储和 API 容量；
- **AI allowance**：可使用哪些研究动作、included credits、共享池和 overage policy。

这样才能支持运营面板手动赠送案例权限、临时增加容量、补偿 AI credits、让付款管理员与工作区管理员分离，以及未来不改套餐代码就增加专业内容。

### 超额策略应按资源类型不同处理

- table / field / record：到限后保留数据、允许读取 / 删除，禁止继续增长，提示升级；不自动收取行数费用。
- AI credits：额度用尽后阻止高成本动作，或由付款管理员明确启用 credits 加购 / 自动充值。
- 内容授权：到期后不能发起新的全文查询；历史回答保留其引用元数据和生成时授权快照，但是否继续展示受授权协议约束。
- 批量导出 / API：单独限额、审计和合同授权，不能等同于人在界面中的研究访问。

## 建议的下一项决策

在 wayfinder 中，下一张票不应讨论具体价格，而应先确定：

> Plus / Pro / Max 分别向律师承诺完成什么工作结果，以及核心法规、核心案例、专业内容、自建容量和 AI 研究在三档之间如何分布。

只有先锁定每档的“可完成工作”，才能再测试价格、额度数字和年付折扣；否则 table 数、record 数和 AI 次数会变成没有价值锚点的参数堆砌。
