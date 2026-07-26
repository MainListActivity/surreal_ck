Status: done
Label: done
Assignee: grok

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

- [x] 无资源来源、能力不兼容、policy apply/readback 失败的新 workspace 永不 active。
- [x] provisioning 各阶段崩溃可幂等恢复或进入明确 error，不产生无限额可访问 database。
- [x] migration requirement 不满足时版本不推进、不部分执行。
- [x] existing workspace 未 native_verified 时不会提前运行 legacy cleanup。
- [x] IdP default/switch/create scope 都使用同一 active+quota gate。

## Dependencies

- Blocked by: [`建立 _system 订阅、权益、调和与运营权威 schema`](02-system-control-plane-schema.md)、[`实现 entitlement resolver 与确定性 policy compiler`](03-entitlement-resolver-policy-compiler.md)、[`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)
- Blocks: [`实现旧事件配额盘点、回填与分批切换 conductor`](09-legacy-quota-migration-conductor.md)、[`完成双仓 E2E、部署切换与发布验收`](10-cross-repo-e2e-release.md)

## Comments

**2026-07-26（Grok，完成）**

- `_system` 009 增量：`provisioning_stage`、`quota_migration_state`、`provisioning_error*`、int 型 `last_migration_version` 与 `last_migration_at`。
- workspace template 021 deferred cleanup 删除 legacy event/tables；manifest `WORKSPACE_MIGRATION_REQUIREMENTS[21]` 要求 `native-quota-v1` + `native_verified|cleanup_done`。
- `migration-runner` 去掉 `version >= 20` 重装特判；按 continuous eligibility 执行，blocked 不推进 version，失败写回 `_system`。
- provisioning saga：显式 `planKey` → reserve → entitlement/projection → 物理库 → native apply/INFO/ledger → `native_verified` → 模板/owner/index → active → scope gate。
- 统一 `evaluateWorkspaceScopeGate`：default-scope、switch-workspace、create 后签发共用。
- 启动期 `seedQuotaPlans` 播种 trial/plus/pro/max/retention 完整 compiler 规则。
- 验证：`pnpm typecheck`、`pnpm test`（shared 91 / server 261 / web 472 pass）、`surreal validate` 009/021 OK。
