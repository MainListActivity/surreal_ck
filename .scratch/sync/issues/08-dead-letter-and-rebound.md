Status: ready-for-agent
Label: ready-for-agent

# SYNC-008 — Dead-letter 流：语义拒绝 → 记表 + 回拉远端覆盖本地

## Parent

`docs/adr/sync.md`

## What to build

把上行 worker 中的失败分类正式化：网络/5xx 走重试，语义拒绝（PERMISSIONS / 校验失败 / FK / schema mismatch）走 dead-letter 流。

具体范围：

- `src/main/sync/error-classify.ts`：从 SurrealDB 错误中分类为 `transient` 或 `semantic`。
  - `transient`：连接错、超时、5xx、`AuthenticationFailed` 这类“可恢复”
  - `semantic`：PERMISSIONS 拒绝、字段 ASSERT 失败、引用不存在等。能通过错误 message 模式匹配判定。
- 上行 worker 推送失败时：
  - transient → cursor 不前进、按指数退避（沿用 SYNC-005 中策略）。
  - semantic → 写入 `sync_dead_letter`（target_table / target_id / versionstamp / op / error_message / created_at），cursor 前进（跳过该条）。
- dead-letter 写入后立即触发 reconciliation：`SELECT * FROM <table>:<id>` 从远端读权威状态 → `applyRemoteChange(...)` 覆盖本地（含 `_origin_session_id = 'remote:reconcile'`）。如果远端返回空（记录已被远端删除）→ `DELETE <table>:<id>` 本地。
- RPC `getSyncStatus()` 返回真实 `deadLetterCount`。
- 新增 RPC `listDeadLetters({ limit, offset })` / `discardDeadLetter(id)` / `forceReapply(id)`，供 SYNC-011 UI 使用；本 issue 只暴露 RPC，不做 UI。
- 单测：
  - mock 远端返回 PERMISSIONS 错 → 进 dead-letter，cursor 前进。
  - mock 远端返回 5xx → cursor 不动，下次轮询继续。
  - dead-letter 后从远端 reconcile：远端有 → 本地字段被覆盖；远端无 → 本地记录被删除。

## Acceptance criteria

- [ ] 错误分类器对 SurrealDB 已知错误模式有单测覆盖（PERMISSIONS、ASSERT、连接错、5xx 各一）。
- [ ] 语义错误正确进 dead-letter，cursor 正确前进，本地从远端 reconcile 完成。
- [ ] `listDeadLetters` / `discardDeadLetter` / `forceReapply` RPC 行为正确。
- [ ] 大批量 dead-letter（如 100 条）不阻塞主循环（异步 reconcile 排队，避免与正常 SHOW CHANGES 抢资源）。

## Blocked by

- `.scratch/sync/issues/05-uplink-tracer-workspace.md`
