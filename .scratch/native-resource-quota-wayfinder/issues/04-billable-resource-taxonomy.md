Status: done
Label: done
Assignee: /root

# 锁定首期可计费资源与口径

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

首个可交付版本究竟硬限制哪些资源，以及每种资源如何计数？必须区分 SurrealDB 的全部 table 与 surreal_ck 用户创建的“数据表”，明确系统表、视图、关系表、索引和内部元数据是否计入；记录额度是 database 总量、每 table 明细、通配默认值还是三者组合；字段、存储、LIVE 和查询额度哪些进入首期，哪些明确后置。

## Dependencies

- Blocked by: [`摸清 SurrealQL 资源定义与权限扩展面`](01-surrealql-resource-definition-extension.md)、[`摸清 SurrealDB 写路径与事务内计量扩展面`](02-surrealdb-transactional-enforcement-extension.md)、[`摸清 surreal_ck 现有配额与控制面迁移边界`](03-surreal-ck-control-plane-audit.md)
- Blocks: [`确定配额策略的作用域、继承与管理权限`](05-policy-scope-inheritance-authority.md)、[`选择原生策略与用量账本的数据模型`](06-native-policy-usage-model.md)、[`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)

## Comments

### 2026-07-24 — 已确认的范围

- 首期原生硬配额必须覆盖 table 数、field 数和 record 数，不能把 field 配额后置。
- table 与 record 规则必须支持按物理表名动态匹配；surreal_ck 的明确用例是只计量并限制名称以 `ent_` 开头的动态实体表。
- 表名匹配器首期固定为两种：精确表名与正则；不单列 prefix/glob，也不接受任意 SurrealQL 表达式。`ent_` 前缀用正则表达。
- 正则对完整物理表名执行 SurrealDB 现有标准正则语义，不自动补首尾锚点；`ent_` 前缀由 `^ent_` 表达。正则在定义策略时编译校验，并沿用引擎现有大小限制。
- table 用量按匹配到的真实 table definition 计数；普通表、关系表和视图每个定义均计 1。引擎内部 catalog 元数据不计入，计数不依赖 surreal_ck 的 `sheet` 业务记录。
- field 用量按匹配表上的显式 SurrealDB field definition 计数；嵌套字段和 `created_at` / `updated_at` 等显式系统字段均各计 1。隐式 `id`、关系表隐式 `in` / `out` 以及 SCHEMALESS 记录中的未定义属性不计入。
- record 规则用表名匹配器选择目标表，但用量与上限按每张命中表独立维护；首期不提供多表共享的 record 总池。例如 `^ent_` 的 10,000 上限表示每张命中表各自最多 10,000 条。
- field 规则同样由表名匹配器选择目标表，用量与上限按每张命中表独立维护；首期不提供多表共享的 field 总池。

### 2026-07-24 — Resolution

首期原生硬配额固定为 table、field、record 三类。三类规则均通过“精确物理表名”或“标准正则”选择资源；table 对全部命中的真实 table definition 做集合计数，field 与 record 对每张命中表独立计数。正则复用 SurrealDB 现有语义、编译校验和大小限制。

field 只计显式 field definition；record 只计各目标表当前存在的逻辑记录。index、存储字节、LIVE subscription、并发查询和请求速率明确不进入首期。
