Status: ready-for-agent
Label: ready-for-agent

# SYNC-005 — 端到端 tracer：本地写入 → CHANGEFEED → 推到远端

## Parent

`docs/adr/sync.md`

## What to build

跑通完整的上行同步链路，但只覆盖一张同步表。选 `workspace.name`（小表、所有用户都有数据、字段简单）作为 tracer。这一刀验证：本地业务写入 → 本地 CHANGEFEED 抓到 → worker `SHOW CHANGES SINCE` 读到 → 推送到远端 `UPDATE workspace:xxx MERGE { name: ... }` → cursor 前进。

具体范围：

- 新增 `src/main/sync/local-to-remote-worker.ts`：
  - 启动时间隔 500ms（空闲后退到 5s），仅在远端可达且 schema 版本一致时运行。
  - 每轮：对 `SYNC_SCOPE` 中所有表（本 issue 仅 `workspace`）执行 `SHOW CHANGES FOR TABLE <t> SINCE <cursor> LIMIT 100`。
  - 过滤：`_origin_session_id` 以 `remote:` 开头的变更跳过（echo 防护）。
  - 把变更转为远端操作：CREATE → `db.create(record).content(...)`；UPDATE → `db.update(record).merge(dirtyFields)`；DELETE → `db.delete(record)`。
  - 推送成功后 UPSERT `sync_cursor:('local_to_remote', <table>)` 前进。
  - 推送失败：网络错 / 5xx 不前进 cursor，按指数退避（1s/4s/16s/1min/5min/30min 循环，无上限）；语义拒绝（PERMISSIONS / 校验）本 issue 暂时也按网络错处理，等 SYNC-008 接入 dead-letter。
- 网络可达性判断：复用 `setOfflineMode` / `getOfflineMode`；远端 connect 失败时进 offline。
- RPC `getSyncStatus()` 返回真实的 pendingCount（本表 SHOW CHANGES count）和 `lastLocalCursorAt`。
- 单测：
  - 本地写入一条 workspace.name 变更，sessionId = local，worker 推送到 mock 远端成功，cursor 前进。
  - 本地有一条 `_origin_session_id = 'remote:vs1'` 的变更，worker 跳过不推。
  - mock 远端抛网络错，cursor 不前进，下一轮重试。

落地约束：

- 本 issue 只覆盖 `workspace` 一张表。其他表（含 ent_*）在后续 slice 接入。
- 字段级 MERGE 在本 issue 已成型（`UPDATE record MERGE { dirtyFields }`），但 dirtyFields 在本 issue 中可以简单理解为“CHANGEFEED 变更体里出现的字段”。`workspace.name` 字段单一，足以验证。

## Acceptance criteria

- [ ] 启动 worker 后，在 WebView 中调 RPC 修改 `workspace.name`，2 秒内远端可见变化（通过外部 surreal cli 或 dashboard 验证）。
- [ ] 同样的写入再次发生时不会重复推送（cursor 正确前进）。
- [ ] mock 远端断网时本地写入仍成功，恢复后 worker 自动续推。
- [ ] 单测覆盖：echo 跳过、网络错重试、cursor 前进语义。
- [ ] worker 不会启动两次（idempotent）；登出时正确停止。

## Blocked by

- `.scratch/sync/issues/03-changefeed-and-origin-fields.md`
- `.scratch/sync/issues/04-remote-schema-deployment-and-exec-template.md`
