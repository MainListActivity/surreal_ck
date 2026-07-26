Status: done
Label: done
Assignee: codex

# SCK-NQ-01 — 建立跨仓 quota contract、SDK 固定版本与启动能力门

## Parent

[`surreal_ck 订阅配额控制面实施规格`](../PRD.md)

## What to build

- 在 shared 建立版本化 capability、INFO STRUCTURE、operation result、quota error 和 compatibility manifest 类型/validator。
- Browser/server `surrealdb` 依赖改为精确版本，增加 HTTP+WebSocket 结构化错误保真 contract tests。
- 建立窄 `NativeQuotaClient` interface；quota grammar 只出现在 adapter，业务模块消费 typed DTO。
- 启动时先 HTTP capability/readiness，再以 root 对 `_system` 做无副作用 quota INFO handshake；早于任何 schema migration。
- 缺失/未知 capability、fork id、format、backend certification 或 SDK error contract 时进入诊断但不服务状态。

## Acceptance criteria

- [x] validator 对兼容/未知 major/缺字段/vanilla fixture 的结果固定。
- [x] HTTP 与 WebSocket quota errors 保留 `code/retryable/details`，无 message parser。
- [x] capability gate 失败时不执行 `_system`/workspace migration、不创建 workspace、不签发 scope。
- [x] `server` 与 `web` 使用相同精确 SDK 版本和 shared contract。
- [x] compatibility manifest 可关联 app release、fork digest、SDK/CLI、contract/format 与 backend。

## Dependencies

- Blocked by: [`SurrealDB：建立 QUOTA grammar、catalog 与父层 IAM`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/01-quota-resource-grammar-catalog-iam.md)；完整集成另受 [`INFO/REBUILD/error`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/05-info-rebuild-errors-observability.md) 与 [`capability/readiness`](/Users/y/IdeaProjects/surrealdb/.scratch/native-resource-quota/issues/06-capability-readiness-migration-cli.md) gate
- Blocks: [`实现 NativeQuotaClient、reconciler 与四类恢复循环`](04-native-client-reconciler-sweeps.md)、[`改造 workspace provisioning、scope 与 capability-aware migrations`](05-workspace-provisioning-migration-gates.md)、[`实现角色化 quota API、错误映射、缓存与预警`](07-quota-api-errors-alerts.md)

## Comments

**2026-07-25（Codex，完成）**

- `shared/src/native-quota/**` 已固定 capability、INFO、policy/rebuild operation result、structured error 与 deployment compatibility manifest 契约；production capability 只接受精确 fork/format/CLI 和通过完整 contract suite 的 RocksDB。
- `server/src/db/native-quota/**` 已提供窄 `NativeQuotaClient`；应用侧 quota SurrealQL 仅存在 adapter。启动顺序为 HTTP capability → required-capability readiness → root `_system` INFO → `_system` schema → workspace migrations。
- capability 或 root INFO gate 失败时不装配 Hono app、不监听，因而 workspace/scope endpoints 不可用；root INFO 失败会先关闭 root，并输出结构化 stage/code/diagnostics。
- `server`、`web`、`shared` 的 `surrealdb` 均精确固定为 `2.0.8`；HTTP/RPC 与 WebSocket query-result contract tests 都只读取 `kind/details`，不解析 message。
- 验证：shared/server/web 全量测试通过；全仓 TypeScript/Svelte typecheck 0 error（现有 5 个 Svelte deprecation warnings）。
