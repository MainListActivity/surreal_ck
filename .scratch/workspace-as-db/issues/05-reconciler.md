Status: done
Label: ready

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

- [x] 启动时跑一次：正常情况 0 漂移，日志一行总结。
- [x] 手工删除一条 `_system.user_workspace_index` → reconciler 发现并补回 / 记录 drift。
- [x] 手工把 index role 改错 → reconciler 按 ws db user.is_admin 修复。
- [x] 某个 workspace db 不可达 → reconciler 失败但 server 仍启动（reconciler 不阻塞 boot；下次心跳重试）。
- [x] 心跳间隔可由 env 配置。

## Blocked by

- `.scratch/workspace-as-db/issues/03-workspace-scope-module.md`

## Notes

- 本 issue 不调用 IdP admin API；IdP 只签 token scope。
- 成员管理的主写路径后续要明确；reconciler 是兜底，不是热路径。
- 不在本 issue 做 drift 历史归档；未来若需要审计可加 `workspace_index_drift_log`。

## 实现落点

- `server/src/db/reconciler.ts`：核心 + 调度
  - `classifyWorkspaceDrift(indexRows, userRows)` —— 纯函数，权威方向 = ws db `user.is_admin`；ws-only user → `add-index`；role 不符 → `fix-role`；index-only → `flag-orphan-index`（MVP 只告警不删，保留历史归因）。
  - `reconcileWorkspaceIndex(db = getRootConnection(), { namespace })` —— root `USE _system` 取 active workspace；逐 db 比对，单 db 抛错记入 `failedWorkspaces` 并切回 `_system`，不阻塞整轮；末尾一行 `console.info("[reconcile]", …)` 汇总。
  - `startReconcileLoop({ intervalSec, runOnce, setInterval, clearInterval })` —— 启动立即跑一次（fire-and-forget，不阻塞 boot），按 `RECONCILE_INTERVAL_SEC` 周期重复；单轮失败被吞，下个 tick 重试；返回 `{ stop() }`。
- `server/src/env.ts`：新增 `RECONCILE_INTERVAL_SEC`（`z.coerce.number().int().positive().default(3600)`）。
- `server/src/startup.ts`：listen 之后启动心跳，`try/catch` 吞启动异常（心跳起不来不影响对外服务）；`shutdown` 时 `reconcileLoop?.stop()` 再 `closeRoot()`。

## TDD slice 记录

逐切片 red→green：

1. 正常无漂移：`reconcileWorkspaceIndex` 返回 0 drift / 0 repaired，无任何写入（tracer）。
2. ws-only user 补 index：断言 `INSERT … ON DUPLICATE KEY UPDATE` 参数含 subject/email/db_name/role(participant) 与 `workspace` record。
3. role 漂移修复：断言 `UPDATE $membership SET role` 命中 membership id、role=admin（以 `is_admin` 为准）。
4. index-only 孤儿：drift=1、repaired=0、零写入（只告警不删）。
5. 单 ws db 不可达：`failedWorkspaces:["ws_down"]`，健康 workspace 仍处理，整体不抛。
6. 心跳调度：启动立即跑一次 + 注册 `intervalSec*1000` 定时器，`stop()` 清定时器；`runOnce` 抛错被吞、定时器仍在、下个 tick 继续。
7. 接入 startup：心跳在 `listen` 之后启动且不阻塞 boot；`startReconcileLoop` 启动抛错被吞、server 仍返回并监听；`shutdown` 先停心跳再关 root。

定时器与 `runOnce` 经 DI 注入（fake timers），不依赖真实 `setInterval`，测试零等待。`server` 全量 src 测试 38 pass / 0 fail，`tsc --noEmit` 无错误。
