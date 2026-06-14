Status: done
Label: done

# WP-D1-08 — workflow_run 归因到真实 $auth 并可持久化/恢复

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

让 Mastra `WorkflowsStorage` 在当前 workspace database 的 `workflow_run` 表中可靠持久化 Router workflow 快照，并把归因交给 caller session 的真实 `$auth`。后端不得把 OIDC `sub` 当成 `user:<id>` record 写入 `owner_user`；如果 storage 需要显式 owner，也必须先通过当前 caller session 得到真实 `user` record。

完成后，用户发起 AI 对话时能在对应 workspace 的 `workflow_run` 中看到 run；未完成 run 在服务重启后仍可按 runId 加载并 resume。

## Acceptance criteria

- [x] `workflow_run` 的 create/update/select 使用 per-run caller session 执行，符合 workspace schema 的 `DEFAULT $auth` 和 `PERMISSIONS`。
- [x] storage 不再把 OIDC subject 字符串直接包装成 `StringRecordId` 写入 `owner_user`。
- [x] 成功启动 Router workflow 后，当前 workspace db 中能查询到对应 runId 的 `workflow_run` 记录。
- [x] suspended run 能从 `workflow_run` 加载 state 并通过 resume 路径继续执行。
- [x] storage 写入失败时日志保留足够诊断信息，并通过 RunBus/上层路径暴露可见失败，不再让前端无限停在“路由中”。
- [x] 测试覆盖 `$auth` 归因、OIDC subject 不是 record id 的回归、持久化后加载和 resume。

## Delivered

- `SurrealWorkflowsStorage` 的 `workflow_run` 持久化继续走注入的 per-run caller session，并让 workspace schema 通过 `DEFAULT $auth` 归因。
- storage 写入不再携带 `owner_user`，OIDC `sub` 不会被当成 `user:<id>` 或 `StringRecordId` 写入业务表。
- `persistWorkflowSnapshot` 写入失败时记录 workflowName/runId/status/cause，并向 workflow 引擎抛错，交给上层 RunBus error 路径暴露给前端。
- 补充 storage 回归测试：`owner_user` 不写入、非 record id OIDC subject 不被包装、写入失败会抛出可诊断错误。
- 复跑 suspend/resume 集成测试，覆盖从 `workflow_run` 加载 state、跨实例 resume 和暂停前用户上下文恢复。

## Blocked by

- `.scratch/mastra-router-migration/issues/07-per-run-caller-session.md`
