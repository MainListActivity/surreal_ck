Status: ready-for-agent
Label: ready-for-agent

# SYNC-010 — 离线模式与 cursor 过期处理

## Parent

`docs/adr/sync.md`

## What to build

把同步 worker 与现有离线模式（`setOfflineMode` / `getOfflineMode`）正确耦合，并处理 cursor 超 7 天的两种边界：

1. **本地 changefeed 滞后**：用户离线 > 7 天后回到在线。本地 cursor 指向的 versionstamp 已超出本地 changefeed 保留期。
2. **远端 cursor 滞后**：用户长时间离线后回到在线。远端 cursor 指向的 versionstamp 已超出远端 changefeed 保留期 → 需要本地清空 + 全量重建。

具体范围：

- 离线/在线状态机：
  - `connectRemote` 成功 / 失败时正确切换 `_offlineMode`。
  - 在线 → 离线：两个 worker pause（保留循环 timer，但条件跳过执行）。
  - 离线 → 在线：worker resume，第一轮先重新做 cursor 健康检查（见下）。
- cursor 健康检查（每次从离线进入在线时执行一次）：
  - 本地：`SHOW CHANGES FOR TABLE <t> SINCE <local_cursor> LIMIT 1`。若返回 “cursor too old” 错误 → 标记 `localChangefeedStale = true`，状态栏强提示“本地有未推送变更，请上云后检查”，但 worker 继续以最新可用 versionstamp 推送（用户的“仍想保留信息”需求）；将这些未能确认推送的 record 加入 `sync_dead_letter` 供后续核对。
  - 远端：同上检测远端 cursor 是否被吞。若被吞 → 触发“全量重建”流程：
    - 对每张同步表 `SELECT * FROM <table>` 拉取所有可见记录（PERMISSIONS 自动过滤）。
    - 用 `applyRemoteChange` 逐条覆盖本地（带 `_origin_session_id = 'remote:rebuild'`）。
    - 本地原有但远端不存在的记录 → 本地删除（仅同步表）。
    - 重置 `sync_cursor:('remote_to_local', <table>)` 为远端当前最大 versionstamp。
- 仅本地表（mastra_*、token_store、sync_*、observability_*）在全量重建中完全不被触碰。
- 单测：
  - 模拟“本地 cursor too old” → `localChangefeedStale = true`，worker 仍工作。
  - 模拟“远端 cursor too old” → 触发全量重建，单测验证本地表与 mock 远端一致。
  - 全量重建过程中产生的新本地写入（用户继续编辑）：重建完成后这些写入仍能正确推送（cursor 推进逻辑正确）。

## Acceptance criteria

- [ ] worker 在离线时不发起任何远端请求；在线时正常运行。
- [ ] 本地 cursor 失效时不阻塞应用，状态栏给出明确提示。
- [ ] 远端 cursor 失效时完整重建本地，期间不影响业务读路径。
- [ ] 重建过程中触发的本地写入在重建完成后仍能推送到远端。
- [ ] 仅本地表不被重建。

## Blocked by

- `.scratch/sync/issues/06-downlink-tracer-workspace.md`
- `.scratch/sync/issues/08-dead-letter-and-rebound.md`
