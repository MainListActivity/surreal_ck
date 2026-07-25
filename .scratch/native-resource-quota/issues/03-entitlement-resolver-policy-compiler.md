Status: open
Label: ready-for-agent
Assignee: unassigned

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

- [ ] 来源优先级、有效期边界、payer switch、trial、override 到期和 retention 使用 table-driven tests。
- [ ] 输入顺序变化不改变 canonical projection/digest。
- [ ] exact/regex、重叠与 unlimited 输出符合 native contract fixture。
- [ ] 缺兜底、非法 regex、重复 exact、负数/溢出或未知资源编译失败。
- [ ] Plus/Pro/Max 数值只存在 plan revisions，不再在 shared TS 与 workspace template 重复硬编码。

## Dependencies

- Blocked by: [`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`SurrealDB：建立 QUOTA grammar、catalog 与父层 IAM`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/01-quota-resource-grammar-catalog-iam.md)
- Blocks: [`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)、[`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)
