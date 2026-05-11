Status: ready-for-agent
Label: ready-for-agent

# SYNC-012 — app_setting sensitive 过滤 + 仅本地表黑名单回归

## Parent

`docs/adr/sync.md`

## What to build

落地 ADR §6 中“app_setting 中 sensitive=true 的行不上云”的 row-level filter，并补一组回归测试确保仅本地表清单不会因为后续重构悄悄上云。

具体范围：

- 在 `src/main/sync/scope.ts` 的 `app_setting` 注册项上挂 `rowFilter: (row) => row.sensitive !== true`。
- 上行 worker 在推送 `app_setting` 变更前，按 `rowFilter` 过滤。被过滤的变更：
  - 跳过推送
  - cursor 仍前进（避免反复重读）
  - 不写 dead-letter（这是设计内的“跳过”）
- 下行 worker 应用远端 `app_setting` 变更时，直接 apply 到本地，不做过滤（远端记录已经过滤过 sensitive=true，远端永远不会有这种行；防御性：若收到则 ignore）。
- 仅本地表清单回归测试（必须独立运行的单测）：
  - 列出 ADR §6 中的“仅本地”清单。
  - 对每张表执行 `assert isInScope(table) === false`，并断言 schema 中确实没有 CHANGEFEED / `_origin_session_id`。
  - 包含动态前缀的反向断言（如不存在的 `wrong_*` 通配不会被错误匹配）。
- 端到端：在本地 app_setting 插入一条 sensitive=true（含 mock API Key）+ 一条 sensitive=false，远端只应看到后者。

## Acceptance criteria

- [ ] sensitive=true 的 app_setting 行永远不出现在远端。
- [ ] sensitive=false 的 app_setting 行正常上行同步。
- [ ] 仅本地表清单的回归测试覆盖所有 ADR §6 列出的项，并能在新人误加 CHANGEFEED 时立刻失败。
- [ ] 上行 worker 在跳过 sensitive 行时 cursor 仍前进，不卡循环。

## Blocked by

- `.scratch/sync/issues/03-changefeed-and-origin-fields.md`
