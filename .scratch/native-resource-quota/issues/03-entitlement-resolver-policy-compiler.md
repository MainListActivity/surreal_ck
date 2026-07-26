Status: done
Label: done
Assignee: codex

# SCK-NQ-03 — 实现 entitlement resolver 与确定性 policy compiler

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- resolver 选择 paid/contract 优先、否则 trial、否则既有 workspace retention；新 workspace 无来源不激活。
- 解析不可变 plan revision 与至多一个 override，生成 immutable entitlement snapshot 和 desired pointer。
- compiler 把 resource rules 规范化为 exact/regex TABLE/FIELD/RECORD，生成稳定 rule id、contract/compiler version、canonical digest 与客户 label mapping。
- 必须生成 `.*` 安全兜底及 `^ent_` 产品规则/精确系统例外；unmatched 覆盖缺口编译失败。
- 商业来源变化即使额度相同也形成审计链；相同规则允许无 DDL readback 同步。

## Acceptance criteria

- [x] 来源优先级、有效期边界、payer switch、trial、override 到期和 retention 使用 table-driven tests。
- [x] 输入顺序变化不改变 canonical projection/digest。
- [x] exact/regex、重叠与 unlimited 输出符合 native contract fixture。
- [x] 缺兜底、非法 regex、重复 exact、负数/溢出或未知资源编译失败。
- [x] 原生路径的 Plus/Pro/Max 数值只来自 plan revisions；shared TS 已移除重复常量，历史 `020` 仅冻结为 NQ-09 切换前的 legacy migration。

## Dependencies

- Blocked by: [`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`SurrealDB：建立 QUOTA grammar、catalog 与父层 IAM`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/01-quota-resource-grammar-catalog-iam.md)
- Blocks: [`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)

## Comments

**2026-07-26（Codex，完成）**

- 新增纯函数 entitlement resolver：统一处理 paid/contract/manual、trial、past-due grace、retention、payer switch、半开有效期与单一 override；来源变化即使规则相同也生成新的审计 digest，相同来源则返回幂等 desired pointer。
- 新增确定性 policy compiler：校验完整的 TABLE/FIELD/RECORD `.*` unlimited 兜底、`^ent_` 产品规则和精确系统例外，输出 native exact/regex selector、稳定 rule id、客户 label mapping 与只依赖可执行语义的 canonical digest。
- compiler 直接以跨仓 `NativeQuotaRuleSchema` 验证输出；重复 selector/rule key、非法或 native 不支持的 regex、负数、SurrealDB `int` 溢出、未知资源、缺覆盖和非法 retention 均 fail closed。
- `_system` 007 增量把 projection selector 升级为 native `table`/`pattern` 形状，并补充不可变 `rule_labels`。共享 TypeScript 中的旧 Plus/Pro/Max 常量已删除。
- `shared/sql/workspace-template/020-resource-quota.surql` 暂不能删除：当前 workspace 创建与 legacy record guard 仍依赖该增量。它已标记为禁止修改的 legacy-only migration，按已锁定的 NQ-09 流程，在所有 workspace 完成 native policy readback 后事务化移除，避免迁移窗口 fail-open。
- 验证：`pnpm test`、`pnpm typecheck`、18 个 resolver/compiler 定向测试、官方 `surreal validate`、真实 SurrealDB `_system` 七段迁移测试（37 assertions）及旧 Plus/Pro/Max 配额集成测试（55 assertions）全部通过。
- `@surrealdb/surql-fmt` 当前会错误改写 `rules.*` 通配字段路径；本增量以官方 CLI validate、真实执行测试和静态路径断言为语法/回归权威。
