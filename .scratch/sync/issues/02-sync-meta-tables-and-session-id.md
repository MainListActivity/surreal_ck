Status: ready-for-agent
Label: ready-for-agent

# SYNC-002 — Sync 元表与本机 sessionId 初始化

## Parent

`docs/adr/sync.md`

## What to build

为后续同步链路准备“元层”：仅本地的两张元表 + 进程启动注入的本机 sessionId + 一个最小的 RPC，让前端能展示当前同步状态（暂时全 0）。

不实现真正的 worker。这一刀只确保后续 slice 可以把 cursor、dead-letter、sessionId 接进去。

具体范围：

- `schema/main.surql` 新增 `sync_cursor` 表：仅本地，PERMISSIONS FULL，记录每张同步表的两个方向 cursor（`direction` ∈ {local_to_remote, remote_to_local}）。
- `schema/main.surql` 新增 `sync_dead_letter` 表：仅本地，PERMISSIONS FULL，记录失败条目（target_table / target_id / versionstamp / error / created_at）。
- 进程启动（`initEngine` 之后、`initUserDb` 内部）生成本机 sessionId（`crypto.randomUUID()` 或 ULID），并在 localdb 上执行 `DEFINE PARAM OVERWRITE $current_session_id VALUE "<sid>"`。
- 新增 `src/main/sync/session.ts`，导出 `getLocalSessionId()`。
- 新增 RPC `getSyncStatus()` 返回 `{ online, sessionId, pendingCount, deadLetterCount, lastLocalCursorAt, lastRemoteCursorAt }`。当前 pendingCount/deadLetterCount 直接从两张元表查询；尚无 worker 时均为 0。

注意：`sync_cursor` 与 `sync_dead_letter` 因为仅本地，绝不能进入同步表清单，需要在 `src/main/sync/scope.ts`（在 SYNC-003 创建）的 fail-closed 默认下天然被排除；本 issue 暂时只在 schema 上加注释说明。

## Acceptance criteria

- [ ] localdb 启动时正确执行 `DEFINE PARAM $current_session_id`，能在后续查询中读到。
- [ ] `sync_cursor`、`sync_dead_letter` 表在本地数据库创建成功，并通过 PERMISSIONS FULL 允许 root 读写。
- [ ] RPC `getSyncStatus()` 可从 WebView 调用，返回上述字段，pendingCount/deadLetterCount 为 0。
- [ ] 单测覆盖：sessionId 在同一进程内稳定、跨重启不同（来自 `crypto.randomUUID`）。
- [ ] schema 注释明确标注两张表“仅本地、绝不出现在同步范围”。

## Blocked by

- `.scratch/sync/issues/01-changefeed-param-event-spike.md`
