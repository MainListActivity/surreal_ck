Status: done
Label: done
Assignee: product-architecture

# 拆分内容访问、资源容量、AI 额度与功能能力

Parent: [`律师行业订阅与平台法律数据产品决策地图`](../PRD.md)

## Question

一个行业套餐如何解析为可独立授予、人工调整、到期、撤销和审计的内容访问权、资源权益、共享 AI 额度与功能能力？

## Dependencies

- [`定义 Plus / Pro / Max 的可完成工作与权益矩阵`](02-plan-outcome-entitlement-matrix.md)

## Expected decision

- 定义计划版本、权益来源、优先级、有效期、覆盖和快照语义。
- 保持现有资源权益只表达 table、field、record 等容量，不用它承载内容或 AI。
- 支持订阅、试用、企业合同、专业模块和人工赠送同时贡献权益。
- 支持运营面板解释“当前为什么拥有这项能力”。

## Source audit

- 现有 `quota_plan_revision` 只允许 table、field、record 规则，且已经作为原生配额编译输入投入使用。
- 现有 `resource_entitlement` 是工作区资源容量的不可变快照，并通过 desired/applied quota projection 指针表达数据库执行状态。
- 现有 `quota_subscription_item` 直接引用 `quota_plan_revision`，因此当前“商业套餐”和“资源配额模板”仍然耦合。
- 内容访问、AI 周期额度和产品功能尚无独立权威模型；把它们追加到 `resource_entitlement.rules` 会破坏既有术语、执行边界和调和语义。

## Decision

### 1. 产品套餐作为聚合层

新增稳定的 `product_plan` 与不可变 `product_plan_revision` 概念。公开 plan key 为 `lawyer_plus`、`lawyer_pro`、`lawyer_max`；revision 固定某一版本完整的商业承诺，但不保存价格、支付状态或运行时用量。

每个 product plan revision 只引用版本化子模板：

```text
product_plan_revision
 ├─ resource_template_revision  -> 既有 quota_plan_revision
 ├─ content_template_revision   -> 内容范围与允许动作
 ├─ ai_template_revision        -> 可用 AI 动作与周期额度策略
 └─ feature_template_revision   -> 产品功能与参数
```

现有 `quota_plan_revision` 保持资源配额专用，不加入内容、AI 或 feature rule。后续 subscription item 应绑定 `product_plan_revision`；资源 resolver 再从产品 revision 取得对应的 quota revision。

### 2. 工作区产品权益快照

每次基础套餐、专业模块、人工赠送或企业合同变化时，resolver 创建一份不可变的 `workspace_product_entitlement` 聚合快照，保存：

- workspace、递增 revision、生效区间和解析时间；
- 基础 `product_plan_revision`；
- 所有参与解析的来源及其有效区间；
- 四个子权益快照的引用与 canonical digest；
- correlation / causation / resolver version；
- 面向运营解释的逐项 provenance，而不是只有最终值。

workspace 保存 desired/current product entitlement 指针。只有资源权益继续额外维护 desired/applied quota projection，因为它需要异步下发到配额受管 SurrealDB；内容和功能在授权入口按 current snapshot 强制，AI 同时检查 current policy 与额度账本。

### 3. 四类权益使用不同合并规则

| 权益域 | 有效结果 | 合并规则 | 运行时状态 |
|---|---|---|---|
| 资源容量 | table/field/record 原生限额 | 单一基础模板 + 至多一个资源 override；不相加 | 复用 `resource_entitlement` 与 quota projection |
| 内容访问 | 可访问内容范围及 search/read/cite/export 等动作 | 基础内容 + 有效专业模块 + 临时赠送取并集；首期不支持 deny 规则 | 不可变 `content_entitlement` 快照 |
| AI 权益 | 允许的 AI 动作、周期额度模板、超额策略 | 能力取并集；周期赠送和购买/补偿额度保留为独立 bucket | `ai_entitlement` + 周期/bucket 消费账本 |
| 功能能力 | audit、API/MCP、批量、团队智能体等 capability | 启用项取并集；参数化上限取明确的最高授权值 | 不可变 `feature_entitlement` 快照 |

不使用一个全局“优先级数字”合并所有权益。每个域定义自己的确定性规则，并把输入、输出与 resolver version 写入快照。

### 4. 权益来源

- 同一工作区同一时刻只有一个商业基础来源：有效付费/合同 subscription 优先，否则 trial；失去来源时进入既有 retention 语义。
- `professional_module_assignment` 可以为工作区增加零到多个专业实务模块；模块不替换基础套餐。
- 平台运营人工动作必须创建版本化、带原因和有效期的 domain-specific grant/override，禁止直接修改当前快照。
- 企业长期差异优先发布内部 product plan revision；短期补偿才使用临时 grant/override。
- AI 购买包或补偿包是有来源、有余额、有失效时间的 credit bucket，不伪装成套餐 revision。

### 5. 生效与撤销

- 任一来源开始、结束、变更或到期都会生成新的聚合快照和受影响的子快照；旧快照不可修改。
- 内容与功能授权在新 current snapshot 发布后用于所有新请求；在途请求固定使用开始时捕获的 entitlement revision。
- AI 动作在预留额度时固定 entitlement revision 与 bucket 消费顺序；失败退款回原预留。
- 资源容量只有 quota projection 经数据库读回确认后才推进 applied；产品聚合快照必须暴露资源子域的 pending/applied 差异，不能宣称尚未下发的容量已经生效。

### 6. 运营解释

运营和客户 DTO 对每项有效能力至少返回：

- entitlement domain 与 key；
- effective value / allowed actions；
- 来源类型、来源记录、客户可见名称；
- effective_from / effective_until；
- 当前状态以及资源域的 desired/applied 状态；
- 若多个来源重叠，列出全部贡献来源而不是只显示“来自 Pro”。

价格、invoice 和 provider event 不进入产品权益快照；它们通过 subscription/source lineage 追溯。
