Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-07 — 实现角色化 quota API、错误映射、缓存与预警

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- Bun 组合 `_system` 与 native INFO，输出 workspace admin、billing admin、participant、operator 四类 allowlist DTO。
- 实现 applied/desired、sync、compliance、capacity、service mode、trusted/stale 与 exact/regex 客户说明。
- shared quota failure union 映射 browser/server SDK errors；participant 裁剪全表真实用量和无权表信息。
- INFO 请求合并、15 秒缓存、显式刷新限速、可见页 60 秒轮询所需接口。
- 80/90/100、over-limit episode、5% rearm、alert state/outbox 和 in-product notification。

## Acceptance criteria

- [ ] 对象 id 不构成授权，跨 workspace/billing account 枚举测试通过。
- [ ] non-member billing admin 只见聚合，不见物理表名/regex 命中；participant 不见总 record 数。
- [ ] at_limit 与 over_limit、unknown 与 0、desired 与 applied 不混淆。
- [ ] quota_exceeded 不重试且保留 draft；policy_changed 只对已证明幂等操作最多重试一次。
- [ ] 相同 threshold episode 不重复通知，projection 变化和 rearm 行为固定。

## Dependencies

- Blocked by: [`建立跨仓 quota contract、SDK 固定版本与启动能力门`](01-contract-sdk-capability-gate.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`实现 subscription lifecycle、service mode 与运营意图`](06-subscription-lifecycle-operator-intents.md)
- Blocks: [`实现客户配额页面与平台运营面板`](08-quota-settings-operations-ui.md)、[`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)
