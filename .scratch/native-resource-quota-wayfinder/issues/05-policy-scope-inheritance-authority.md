Status: done
Label: done
Assignee: /root

# 确定配额策略的作用域、继承与管理权限

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

配额策略允许定义在 instance、namespace、database、table 中的哪些层级，多个层级或通配规则冲突时如何合并？谁能查看和修改每一层策略？必须保证受限 database 的 Owner 无法提高、移除或绕过自己的上限，同时让 instance/namespace 管理员能动态分配，并明确平台 root 与 namespace owner 的职责边界。

## Dependencies

- Blocked by: [`摸清 SurrealQL 资源定义与权限扩展面`](01-surrealql-resource-definition-extension.md)、[`锁定首期可计费资源与口径`](04-billable-resource-taxonomy.md)
- Blocks: [`选择原生策略与用量账本的数据模型`](06-native-policy-usage-model.md)、[`设计原生配额 SurrealQL、错误与可观测契约`](08-native-surrealql-errors-observability.md)、[`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)

## Comments

### 2026-07-24 — 已确认的权限边界

- 只有 root scope Owner 与目标 namespace scope Owner 可以定义、修改或移除配额策略；namespace Owner 只能管理本 namespace 下的 database。
- root/namespace Editor、database Owner/Editor 以及 database 内的 RECORD 身份均无配额修改权。
- 内核使用独立 quota `ResourceKind`，不加入 Editor 的可编辑资源白名单；策略存储层级与 IAM 授权 base 分离。
- 首期策略只挂载到目标 database；table、field、record 选择器都是该 database 策略内的规则。内核不提供 instance/namespace 默认策略或独立 table-level 策略，也不承担 Plus/Pro/Max 模板继承。
- surreal_ck 运营控制面在 `_system` 维护工作区套餐期望态与人工 override，通过 root 编译、下发并读回每个 database 的物化策略；namespace 批量操作由控制面批量调和，不要求内核继承。
- 只读查看沿用目标 database 的 system IAM `View`：root/namespace 上级 Viewer/Editor/Owner 与 database Viewer/Editor/Owner 可查看有效策略和用量，但不能因此获得修改权。database 内的 RECORD 身份不直接获得原生配额 INFO；普通成员若需查看，由 surreal_ck 控制面提供裁剪后的产品接口。
- table 计数的所有匹配规则同时生效，命中多个规则的 table 同时占用各计数桶。field/record 按资源类型独立解析：同一表存在精确名称规则时覆盖该资源的全部正则规则；否则多个命中正则取最小上限。同一资源与精确表名的重复规则在定义时拒绝，不引入 priority 或定义顺序语义。
- 普通 database export/import 与克隆不携带或改变配额策略和用量账本；导入脚本中的 quota DDL 仍按父层 IAM 拒绝 database Owner。配额备份/恢复由 root/namespace Owner 的独立控制面负责，surreal_ck 在目标工作区创建后依据期望态重新物化策略。
- SurrealDB 内核中，没有配额策略表示不限制，以兼容既有 database；只有 root/namespace Owner 能移除策略，移除后立即变为不限制并产生审计事件。surreal_ck 的新工作区必须在套餐解析、策略下发和读回校验成功后才能从 `provisioning` 进入 `active`；active 工作区策略意外缺失时由调和器重下发并告警。
- database 已存在配额策略但某项资源没有命中任何规则时，SurrealDB 内核同样把该资源视为不限制。surreal_ck 的套餐编译器必须为受管资源生成并校验必要的 `.*` 兜底规则，再叠加 `^ent_` 等产品规则或精确系统表例外；缺少必需兜底覆盖时编译失败，工作区不得激活或更新。

### 2026-07-24 — Resolution

首期配额策略只物化在单个 database 上，规则以精确表名或正则选择 table、field、record；内核不实现 instance/namespace/套餐继承。修改权只属于 root Owner 与目标 namespace Owner，database Owner 及 RECORD 身份无法修改或移除；拥有目标 database 或祖先 scope `View` 的 system identity 可以查看策略与用量。

规则冲突采用固定语义：table 的所有匹配桶同时计数；field/record 优先精确规则，否则取命中正则中的最小上限。普通导出、导入和克隆不携带策略或用量。无策略以及有策略但未命中的资源都默认不限额；surreal_ck 必须通过编译期兜底覆盖、下发读回和持续调和，把这一兼容性默认收紧为可运营的套餐边界。
