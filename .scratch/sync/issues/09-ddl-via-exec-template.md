Status: ready-for-agent
Label: ready-for-agent

# SYNC-009 — DDL 路径改造：data-table-runtime 走 execTemplate

## Parent

`docs/adr/sync.md`

## What to build

把 `src/main/services/data-table-runtime.ts` 中所有 schema 编辑路径切到“先远端 execTemplate、再本地 DEFINE”的流程。客户端不再直接对远端发 DEFINE。

具体范围：

- 改造 `provisionEntityTable(tableName)`：
  1. `execTemplate('ent.create', { table_name })`
  2. 远端成功后本地 DEFINE TABLE / FIELD（含 `_origin_session_id` + 注入 EVENT，从 SYNC-003）
- 改造 `provisionEntityFields(tableName, columns)`：对每个 column → `execTemplate('ent.field-add', { table_name, field_name, field_type, field_assert? })` → 本地 DEFINE FIELD。
- 改造 `overwriteEntityField(tableName, column)` → `execTemplate('ent.field-overwrite', ...)` → 本地 DEFINE FIELD OVERWRITE。
- 改造 `removeEntityField(tableName, key)` → `execTemplate('ent.field-remove', ...)` → 本地 REMOVE FIELD。
- 离线检测：从 `getServiceContext().isOffline` 判断；离线时所有 DDL 接口立即抛 `ServiceError('OFFLINE_DDL_FORBIDDEN', '当前离线，无法修改表结构')`。
- 远端调用失败：
  - transient → 抛 `REMOTE_DDL_FAILED`，本地不动，让 RPC 上层透传错误给 UI。
  - semantic → 抛 `TEMPLATE_REJECTED`，本地不动；不写 dead-letter（DDL 没有“稍后重试”语义，由用户决定）。
- 单测：
  - 模板调用成功 → 本地 DEFINE 执行 → 单测验证 INFO FOR TABLE 中字段已加。
  - 模板调用失败 → 本地不变更，错误透传。
  - 离线时直接抛 OFFLINE_DDL_FORBIDDEN，没有远端调用。
- 端到端：在测试 workspace 创建一张新 ent_* 表，加字段、改字段、删字段，远端 dashboard 中能看到对应变更；本地 worker 把空行/有行的数据同步上去时不会因为字段不存在而失败。

## Acceptance criteria

- [ ] 4 个 provision 函数全部经过 execTemplate；不存在直接对远端 DEFINE 的代码路径。
- [ ] 离线时 DDL 立即抛 OFFLINE_DDL_FORBIDDEN，不发起网络请求。
- [ ] 远端失败时本地 schema 不动，错误透传到 UI。
- [ ] 已有调用 `provisionEntityFields` / `overwriteEntityField` / `removeEntityField` 的所有上层 service 通过现有测试。
- [ ] 端到端：新表加字段后写一行数据 → 上行 worker 推送成功（不触发 dead-letter）。

## Blocked by

- `.scratch/sync/issues/04-remote-schema-deployment-and-exec-template.md`
- `.scratch/sync/issues/07-field-merge-all-tables.md`
