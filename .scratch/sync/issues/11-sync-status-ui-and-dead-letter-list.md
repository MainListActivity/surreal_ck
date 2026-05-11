Status: ready-for-agent
Label: ready-for-agent

# SYNC-011 — 同步状态栏 UI + dead-letter 列表

## Parent

`docs/adr/sync.md`

## What to build

把同步状态做成用户可感知的 UI：顶部状态栏 + dead-letter 详情面板。

具体范围：

- 顶部状态栏（在已有的应用 chrome 中加一个 slot，复用 `app-state.svelte.ts` 中 reactive store）：
  - 在线：绿点 + “已同步” / “同步中（N 条待推送）”。
  - 离线：黄/红点 + “离线模式”，hover 提示原因。
  - 不兼容 schema 版本：红点 + “需更新客户端”。
  - 本地 changefeed 过期：红点 + “本地有未推送变更，请检查”。
  - dead-letter > 0：橙点 + “N 条未同步”，点击打开详情。
- dead-letter 详情面板：
  - 列表：表名、记录 ID、错误信息、发生时间。
  - 单条操作：
    - **以远端覆盖本地**：调 `forceReapply(id)`（SYNC-008 已实现，从远端 SELECT 覆盖本地，并删除 dead-letter 条目）。
    - **忽略**：调 `discardDeadLetter(id)`，删除条目（本地状态保持，但可能与远端长期不一致 → 二次确认弹窗）。
  - 批量操作：全部以远端覆盖、全部忽略。
- 实时刷新：用 `setInterval(2000ms)` 调 `getSyncStatus()` 简单轮询，或在 worker 完成一轮后通过 RPC event 推送（任选其一，按现有 RPC 能力决定，不强约束）。
- 端到端验证：手工构造一条 dead-letter（在 mock 远端关闭某 workspace 的 PERMISSIONS），在 UI 看到提示和列表，点击恢复后列表清空。

## Acceptance criteria

- [ ] 状态栏在所有页面都显示。
- [ ] 五类状态（已同步 / 同步中 / 离线 / schema 不兼容 / changefeed 过期 / dead-letter）各有清晰区分。
- [ ] dead-letter 列表的两个操作能正常工作，二次确认存在。
- [ ] 状态栏更新延迟 < 3 秒。
- [ ] 无障碍：状态用图标 + 文字，不仅依赖颜色。

## Blocked by

- `.scratch/sync/issues/08-dead-letter-and-rebound.md`
- `.scratch/sync/issues/10-offline-and-cursor-expiry.md`
