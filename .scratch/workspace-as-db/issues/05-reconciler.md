Status: needs-triage
Label: needs-triage

# WP-C-05 — _system reconciler（IdP webhook 丢消息兜底）

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/db/reconciler.ts
```

启动期 + 每小时心跳跑一次。流程：

1. 用 IdP API（详见 ADR Open Questions 的 IdP 选型）pull 一份 `{ workspaces[], memberships[] }` 全量快照。
2. 与 `_system.workspace` + `_system.user_workspace_index` 对比。
3. 漂移分类：
   - IdP 有、_system 没有 → INSERT（webhook 丢了创建通知）。
   - _system 有、IdP 没有 → DELETE（webhook 丢了删除通知，或 IdP 端被清理）。
   - 两边都有但 role 不一致 → 以 IdP 为权威 UPDATE _system。
4. 所有操作 root 会话；带详细日志（drift kind + dbName + subject）。

env 新增：

- `RECONCILE_INTERVAL_SEC`（默认 3600）
- `IDP_ADMIN_API_URL`、`IDP_ADMIN_TOKEN`（用于 pull 全量；与 webhook 互补）

## Acceptance criteria

- [ ] 启动时跑一次：正常情况 0 漂移，日志一行总结 `reconciled M workspaces, K memberships, 0 drift`。
- [ ] 故意让 issue 03 的 webhook 跳过一次 → 下次 reconciler 把丢失的 _system 行补回。
- [ ] _system 多出一条 IdP 不存在的 workspace → 启动时被 DELETE，日志告警。
- [ ] IdP API 不可达 → reconciler 失败但 server 仍启动（reconciler 不阻塞 boot；下次心跳重试）。
- [ ] 心跳间隔可由 env 配置。

## Blocked by

- `.scratch/workspace-as-db/issues/03-idp-webhook-endpoint.md`

## Notes

- 与 issue 03 互补：webhook 是热路径（实时但可能丢），reconciler 是冷路径（兜底但有延迟）。两者都用 root 写 _system。
- IdP API 协议待定（ADR Open Question）；本 issue 假设 IdP 提供 `GET /admin/workspaces` + `GET /admin/memberships` 类似 endpoint。
- 不在本 issue 做"漂移历史归档"（写一张 drift_log 表）；如果未来要审计可加。
- **不再校对 ws db.user 表**——该表由前端 admin 直接维护 + IdP 同步驱动；权威在 IdP，_system 只是缓存。
