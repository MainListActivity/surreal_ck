Status: done
Label: done
Assignee: /root

# 设计原生配额 SurrealQL、错误与可观测契约

## Parent

[`SurrealDB 原生配额与 surreal_ck 订阅控制面决策地图`](../PRD.md)

## Question

管理员通过何种 SurrealQL 定义、修改、移除和查看策略与实时用量，普通 database 管理员能看到哪些只读信息？需要锁定 grammar、AST、INFO/导出表示、参数单位、幂等语义、结构化 QuotaExceeded 错误字段，以及供 surreal_ck 调和与用户提示使用的稳定观测接口；不要把 Plus / Pro / Max 等商业概念写入数据库内核。

## Dependencies

- Blocked by: [`摸清 SurrealQL 资源定义与权限扩展面`](01-surrealql-resource-definition-extension.md)、[`确定配额策略的作用域、继承与管理权限`](05-policy-scope-inheritance-authority.md)、[`选择原生策略与用量账本的数据模型`](06-native-policy-usage-model.md)、[`定义事务内配额消费、释放与批量写语义`](07-transactional-consumption-semantics.md)
- Blocks: [`确定套餐、订阅与配额权益的权威模型`](09-subscription-entitlement-authority.md)、[`设计 surreal_ck 策略编译与调和流程`](10-policy-compilation-reconciliation.md)、[`确定定制 SurrealDB 的维护、兼容与发布策略`](12-fork-maintenance-compatibility-release.md)

## Comments

### 2026-07-24 — 已确认的 singleton DDL 骨架

- quota 是目标 database 的单例资源，不额外命名 policy；首期使用 `DEFINE/ALTER/REMOVE QUOTA ... ON DATABASE <db>` 管理，目标 database 位于当前 namespace 上下文，跨 namespace 的 root 先 `USE NS`。
- `DEFINE` 创建完整策略，已存在时报错；`IF NOT EXISTS` 在已存在时无副作用。`DEFINE ... OVERWRITE` 原子替换完整策略，已有策略的覆盖必须携带 `EXPECT GENERATION`。
- `ALTER ... IF EXISTS` 可在一个 statement 内增删改多条规则，但执行器仍生成、验证并原子替换完整快照；只有实际变化才推进 generation。
- `REMOVE` 默认要求策略存在；`IF EXISTS` 在不存在时 no-op。移除已有策略必须携带 generation guard。
- grammar/AST 只表达 quota、规则、selector、limit 和 generation，不进入 Plus/Pro/Max、价格或订阅概念；首期不增加 `ON NAMESPACE x DATABASE y` 复合寻址。
- `QUOTA` 是核心新增保留关键字；实施必须覆盖 parser、SQL/expr AST、`ToSql` 往返和保留字回归。当前 CLI 不认识拟议语法，不能在实现前进行有效 validate。

### 2026-07-24 — 已确认的 typed rule grammar

- 单条规则规范形态为 `RULE <rule_id> FOR <TABLE|FIELD|RECORD> MATCH <EXACT table-identifier|REGEX regex-literal> LIMIT <u64|UNLIMITED>`。
- `rule_id` 在整份策略内全局唯一且稳定，不承担展示名语义；同一 resource + exact table 的重复规则拒绝。
- selector 不接受任意 SurrealQL expression、函数、变量或运行时条件。regex 使用引擎现有字面量、大小限制与匹配语义，定义时编译校验且不自动添加锚点。
- limit 只接受非负 `u64` 或显式 `UNLIMITED`；首期三类资源都是数量，不接受单位、小数或动态表达式，`LIMIT 0` 表示禁止净增长。
- field/record 的 exact unlimited 覆盖正则规则；table 继续遵守所有命中桶同时生效，因此 exact unlimited 不抵消另一个有限 table regex。
- 首期 rule 不携带 comment、priority、套餐名、价格或其它商业元数据；动态套餐配置由 surreal_ck 生成完整 DDL。

### 2026-07-24 — 已确认的 ALTER patch 与幂等语义

- `ALTER QUOTA ... EXPECT GENERATION n` 使用 `SET RULE <完整规则>` 与 `DROP RULE [IF EXISTS] <rule_id>` clauses；SET 按 rule_id 覆盖或创建，DROP 默认要求存在。
- 同一 statement 不允许多次操作同一 rule_id；所有 clauses 应用后统一验证并原子替换完整快照，不赋予 clause 顺序语义。
- SET 内容相同、DROP IF EXISTS 未命中、规则仅重排，以及 DEFINE OVERWRITE 提交相同规范化策略均为 no-op：generation 不推进，也不产生策略改变审计事件。
- 规则内部按 rule_id 规范排序，保证 `ToSql` 与策略 digest 稳定。任何实际修改已有策略的 OVERWRITE/ALTER/REMOVE 都必须使用 generation guard。
- IF EXISTS/IF NOT EXISTS 导致 no-op 时优先保持幂等，不因 generation 已变化反向报错。未知提交结果使用旧 generation 重试若遇冲突，调用方必须 INFO 读回确认。

### 2026-07-24 — 已确认的 INFO 与刷新边界

- 新增 `INFO FOR QUOTA ON DATABASE <db>`：默认返回当前 canonical DEFINE QUOTA 文本，无策略返回 NONE；`STRUCTURE` 返回策略、generation、账本状态和实时用量的机器结构。
- quota INFO 使用目标 database 的 system IAM `View`；root/ns/db Viewer、Editor、Owner 可读，RECORD identity 拒绝。
- 聚合 `INFO FOR DATABASE` 只增加轻量 quota definition/generation 摘要用于发现，不展开逐表 usage。
- quota INFO 首期不支持 VERSION；历史 policy 与当前 usage 不混合，长期历史由 surreal_ck 控制面提供。
- 每次 INFO 是事务一致快照而非订阅流；运营面板按需刷新或轮询。首期不增加 LIVE INFO，也不提供一次扫描整个 namespace 所有 database 用量的高基数命令。
- 普通成员需要查看时，由 surreal_ck 提供裁剪后的产品接口，不扩大 RECORD identity 对底层配额策略的可见性。

### 2026-07-24 — 已确认的 STRUCTURE DTO

- `INFO ... STRUCTURE` 返回带 `format_version` 的稳定 DTO，而非内部 KV：顶层包含 database、observed_at、policy、ledger 与 usage。
- policy 包含 generation 和规范排序的 typed rules；selector 与 limit 使用 tagged object，明确区分 exact/regex 与 finite/unlimited。
- ledger 暴露 state、active_epoch 和 usage_trusted。状态不是 ready 时，usage 返回 NONE 且 usage_trusted=false，不把旧 counter 表示为实时真值。
- usage 分为 table rule buckets 与逐物理表 field/record effective usage；effective usage 包含 used、matched/effective rule ids、limit、limit_origin、remaining 与 exceeded。
- `limit_origin` 区分 exact、regex_min、explicit_unlimited 和 unmatched，并单独列出三类 unmatched table names，使控制面能发现内核默认无限所掩盖的策略覆盖漏洞。
- 输出按 table name 和 rule_id 规范排序；INFO format_version 独立于 catalog format_revision 与 policy generation。DTO 不包含套餐、价格、订阅或人工 override 原因。

### 2026-07-24 — 已确认的结构化错误契约

- quota 错误必须跨 HTTP、WebSocket 与 SDK 保留稳定 `code`、`retryable` 和 `details`；message 仅供人类阅读，不是机器契约，不能再次退化为 QueryNotExecuted 字符串。
- `quota_exceeded` 为不可重试错误，details 包含 database、generation 与规范排序的 violations；每项包含 resource、可选 table、rule ids、limit、current、事务净 delta、projected 和 over_by。
- pre-commit 聚合同一事务的全部阻塞性违规，最多返回 64 项并用 truncated 标识截断；不暴露 record ids、原始 query、数据内容或套餐名。
- 固定错误类别还包括：可重试的 `quota_conflict`、可重试的 `quota_policy_changed`、禁止盲重试的 `quota_generation_mismatch`、携带 ledger state 的 `quota_ledger_unavailable`，以及 `quota_policy_invalid`、policy exists/not_found、rule not_found 等 DDL 生命周期错误。
- rebuilding 状态的 ledger unavailable 可稍后重试，corrupt 状态要求管理员处理；具体 retryable 值随结构化 state 返回。

### 2026-07-24 — 已确认的 REBUILD QUOTA 入口

- 新增 `REBUILD QUOTA [IF NEEDED] ON DATABASE <db>`，只允许 root/目标 namespace Owner；它只重建用量 epoch，不修改策略或 generation。
- 普通形式无论当前 state 都重新扫描；IF NEEDED 只在 uninitialized/rebuilding/corrupt 时执行，ready 时 no-op，不隐式扫描验证漂移。
- 命令取得持久化 database 只读 fence，同步扫描并在校验成功后原子切换 active epoch；断连或失败时保持 rebuilding/corrupt，不能误开放写入。
- 结构化结果包含 changed、old/new state、old/new epoch、各资源扫描计数与 duration。
- 首期不增加后台 job、进度订阅、暂停/继续或取消 API；大库异步重建能力后置。

### 2026-07-24 — 已确认的操作结果、审计与 metrics 边界

- quota DDL/REBUILD 返回带 format_version 与 operation_id 的结构化结果，包含 operation、changed、database、前后 generation、ledger state 与 active epoch；控制面成功后仍必须 INFO STRUCTURE 读回。
- policy state 保留最近一次策略变更指针（operation id/action/actor/changed_at/generation），策略被 REMOVE 后仍可读取；它不是完整历史。
- 成功提交后发出关联 operation id 的结构化审计事件；失败尝试只产生带 error code 的结构化日志，不伪装成已提交事件。事件和日志不得包含完整 query、凭证或业务记录。
- 提供 quota denied/conflict/policy change/rebuild outcome/rebuild duration 等低基数 metrics；禁止 namespace/database/table/rule_id 作为 metric label，具体对象通过 INFO 与日志定位。
- 引擎日志/事件服务运行诊断，不承担永久账单历史；套餐、override、操作原因与长期历史由 surreal_ck `_system` 保存。

### 2026-07-24 — 已确认的普通导出与 quota-aware 导出边界

- 普通 database EXPORT 永远不输出 quota policy、generation、usage counters/epoch 或 quota 审计状态，也不提供 database Owner 可开启的 include-quota 选项。
- `QuotaPolicyDefinition::ToSql` 仍生成按 rule_id 规范排序、标准转义且可 parser 往返的 `DEFINE QUOTA ON DATABASE ...` 文本，供 INFO、测试和 root/namespace 控制面使用。
- canonical ToSql 不携带 `EXPECT GENERATION`；generation 是目标 database 的并发状态，不是可移植策略内容。
- quota-aware 备份由 root/namespace Owner 读取专用 INFO STRUCTURE 或 canonical DDL 并保存在控制面；恢复时针对目标 database 重新 DEFINE/OVERWRITE，再重建或读回用量，绝不导入源 counter。

### 2026-07-24 — Resolution

原生管理面采用 database 单例 `QUOTA` 资源：`DEFINE QUOTA` 创建或原子覆盖完整策略，`ALTER QUOTA` 以无顺序的 SET/DROP RULE patch 生成新快照，`REMOVE QUOTA` 解除限制，所有已有策略修改使用 `EXPECT GENERATION`。规则 grammar 固定为稳定 rule_id、TABLE/FIELD/RECORD、EXACT/REGEX selector 与有限 u64/UNLIMITED limit，不执行动态表达式或承载商业套餐字段。

读取面使用 `INFO FOR QUOTA ON DATABASE ... [STRUCTURE]`；文本输出 canonical DDL，STRUCTURE 返回版本化的 policy、ledger 与可解释 usage DTO，明确标识 unmatched 和不可信账本状态。普通 database INFO 只显示轻量摘要，普通 export 不携带 quota；恢复由父层控制面重新物化。账本回填和修复使用同步、受父层授权的 `REBUILD QUOTA [IF NEEDED]`。

所有 quota 错误跨协议保留稳定 code/retryable/details，超限错误聚合并限制 violations；DDL/REBUILD 返回结构化 operation result。内核保留最近变更指针并输出结构化日志、审计事件和低基数 metrics，surreal_ck 负责长期套餐与人工操作历史。首期观测采用事务一致 INFO 轮询，不提供 LIVE INFO、namespace 全量扫描或后台 rebuild job。
