Status: needs-triage
Label: needs-triage

# WP-C-05 — _system reconciler（workspace index 漂移校对）

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/db/reconciler.ts
```

启动期 + 每小时心跳跑一次。IdP 不再是 workspace 权威；reconciler 校对的是 `_system.user_workspace_index` 与各 workspace database 内 `user` 表之间的一致性。

流程：

1. root 查 `_system.workspace`，得到所有 active workspace。
2. 对每个 workspace db：
   - root 读取该 db 的 human `user` 记录（subject/email/is_admin/disabled 状态）。
   - 与 `_system.user_workspace_index` 中该 workspace 的 rows 对比。
3. 漂移分类：
   - ws db user 有、_system 没有 → 记录 drift；若 subject 已存在且状态明确，可自动补 index。
   - _system 有、ws db user 没有 → 标记 index disabled 或记录 drift（MVP 倾向只告警，避免误删）。
   - 两边都有但 role 不一致 → 以 ws db user.is_admin 为准修复 index role。
4. 输出日志汇总：workspace 数、user 数、drift 数、修复数。

env 新增：

- `RECONCILE_INTERVAL_SEC`（默认 3600）

## Acceptance criteria

- [ ] 启动时跑一次：正常情况 0 漂移，日志一行总结。
- [ ] 手工删除一条 `_system.user_workspace_index` → reconciler 发现并补回 / 记录 drift。
- [ ] 手工把 index role 改错 → reconciler 按 ws db user.is_admin 修复。
- [ ] 某个 workspace db 不可达 → reconciler 失败但 server 仍启动（reconciler 不阻塞 boot；下次心跳重试）。
- [ ] 心跳间隔可由 env 配置。

## Blocked by

- `.scratch/workspace-as-db/issues/03-workspace-scope-module.md`

## Notes

- 本 issue 不调用 IdP admin API；IdP 只签 token scope。
- 成员管理的主写路径后续要明确；reconciler 是兜底，不是热路径。
- 不在本 issue 做 drift 历史归档；未来若需要审计可加 `workspace_index_drift_log`。
