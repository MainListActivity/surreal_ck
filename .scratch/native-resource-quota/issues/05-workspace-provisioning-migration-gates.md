Status: open
Label: ready-for-agent
Assignee: unassigned

# SCK-NQ-05 — 改造 workspace provisioning、scope 与 capability-aware migrations

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- workspace 创建改为 fail-closed saga：显式资源来源→entitlement→projection→native policy→INFO/ledger ready→模板→owner/index→active/scope。
- capability gate 早于 system/workspace migrations；migration manifest 支持 `requires_engine_capability` 和 workspace quota migration state。
- 旧 `020-resource-quota.surql` 后续 cleanup 必须 deferred 到 native_verified；新 workspace 在未开放 scope 前完成 native policy 和 legacy cleanup。
- 移除 migration runner 的 `version >= 20` 事件重装特判；失败进度、workspace migration state/error 回写 `_system`。
- scope 签发要求 active、desired/applied 一致、可信账本和未过期 native audit。

## Acceptance criteria

- [ ] 无资源来源、能力不兼容、policy apply/readback 失败的新 workspace 永不 active。
- [ ] provisioning 各阶段崩溃可幂等恢复或进入明确 error，不产生无限额可访问 database。
- [ ] migration requirement 不满足时版本不推进、不部分执行。
- [ ] existing workspace 未 native_verified 时不会提前运行 legacy cleanup。
- [ ] IdP default/switch/create scope 都使用同一 active+quota gate。

## Dependencies

- Blocked by: [`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)
- Blocks: [`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)、[`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)
