Status: ready-for-agent
Label: ready-for-agent

# SYNC-006 — 反向 tracer：远端变更 → SHOW CHANGES → apply 本地

## Parent

`docs/adr/sync.md`

## What to build

把下行（远端 → 本地）链路打通，仍用 `workspace` 一张表作为 tracer。验证：远端发生 `UPDATE workspace:xxx`（来自其他设备或浏览器 dashboard）→ 本地 worker `SHOW CHANGES FOR TABLE workspace SINCE <remote_cursor>` 读到 → apply 到 localdb 时显式写 `_origin_session_id = 'remote:<vs>'` → 上行 worker 看到该变更跳过（不形成自循环）。

具体范围：

- 新增 `src/main/sync/remote-to-local-worker.ts`：2s 间隔（空闲后退到 5s）。
- 新增 `src/main/sync/apply-remote-change.ts`，导出 `applyRemoteChange(table, change)`：
  - 不能依赖 EVENT 注入（EVENT 会用本地 sessionId 覆盖）。落地手段是构造 raw query 显式带上 `_origin_session_id = 'remote:<vs>'`，并依赖 SYNC-003 中 EVENT 的“`_origin_session_id != NONE` 时不覆盖”分支。
  - CREATE → `CREATE record CONTENT $content`（含 `_origin_session_id`）
  - UPDATE → `UPDATE record MERGE $content`
  - DELETE → `DELETE record`
- 冲突保护：apply UPDATE 前查 localdb 是否对该 recordId 有未推送 changefeed 项（与 sync_cursor 中 `local_to_remote` 的位置对照）。若有，仅 merge 远端变更中本地未修改过的字段；本地已修改的字段保留。
- 推送 cursor：`sync_cursor:('remote_to_local', <table>)` 前进到 SHOW CHANGES 返回的最大 versionstamp。
- 在 SYNC-005 的上行 worker 中已经实现的 echo 跳过逻辑，本 issue 通过端到端联调验证。
- 单测：
  - mock 远端 SHOW CHANGES 返回 1 条 update，apply 后 localdb 中字段更新且 `_origin_session_id = 'remote:vs1'`。
  - 同一 recordId 本地有未推送变更时，远端 update 不覆盖该字段。
  - 端到端：模拟两个 localdb（A 与 B 共享一个 mock 远端），A 改了 workspace.name，B 的下行 worker apply 后 B.workspace.name 与 A 一致。

## Acceptance criteria

- [ ] `applyRemoteChange` 写入后 `_origin_session_id` 准确等于 `remote:<vs>`。
- [ ] 上行 worker 不会把刚 apply 的远端变更再次推回（端到端验证）。
- [ ] 本地未推送字段不会被远端变更覆盖（字段级保护）。
- [ ] 离线时下行 worker 暂停；重连后从上次 cursor 续读。
- [ ] 单测覆盖上述三个核心场景。

## Blocked by

- `.scratch/sync/issues/05-uplink-tracer-workspace.md`
