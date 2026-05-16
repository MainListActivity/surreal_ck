Status: needs-triage
Label: needs-triage

# VO-04 — Office dispatcher tracer（按 workspace × employee 维持连接）

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

**Bun server 进程内**新增 **Office dispatcher** 模块。整体行为按 [`virtual-office.md`](../../../docs/adr/virtual-office.md) §3 实现。

### 启动流程

1. 用 SurrealDB root 凭证连 `_system`，`SELECT * FROM workspace`，拿到所有 workspace 列表（`{ slug, db_name }`）。
2. 对每个 workspace：
   a. 用 root 凭证 USE `ws_<slug>` db，`SELECT * FROM user WHERE kind='virtual' AND virtual_profile.status='active'`。
   b. 对每个员工：
      - `SELECT secret FROM employee_credential WHERE employee = <empId>`（root 可读）。
      - 关闭 root 连接，新建一条到该 db 的连接，`SIGNIN { ac: 'employee', ns, db, subject: emp.subject, secret }`，拿到 1h JWT。
      - 用该连接订阅三条 LIVE：
        - `LIVE SELECT * FROM office_task WHERE assignee = $auth AND status = 'open'`
        - `LIVE SELECT * FROM office_message WHERE to = $auth`
        - `LIVE SELECT * FROM user_notification WHERE from_employee = $auth AND resolved_at != NONE`
3. 设一个全局 `setInterval(60s)` 作为心跳器。
4. 设一个 token 续约器：每个员工连接的 token 临到期前 5 分钟，用 secret 再 SIGNIN 一次替换。

### 触发即执行窗口

任一 LIVE 命中 / 心跳到点：

- 加载员工身份 / 岗位 / 当前待办（用该员工连接 SELECT 即可）
- 跑一次 Mastra workflow
- 员工产出的 task / message / report / notification 通过该员工连接写入；归因自动正确（`$auth = 该员工`）
- 心跳触发也用同一连接执行

### 关闭流程

Bun server SIGTERM：关闭所有员工连接、关闭心跳 interval、等待 in-flight workflow 收尾。

### 文件组织

```
server/ai/office/
  dispatcher.ts                 // 启动、停止、按 workspace × employee 维持连接、心跳
  workspace-bootstrap.ts        // 枚举 _system.workspace + 加载活跃员工
  employee-session.ts           // SIGNIN + 续约 + 关闭
  employee-workflow.ts          // Mastra createWorkflow，最小 tracer 步骤
  employee-runtime.ts           // 加载员工身份、tool bundle、token budget
  echo-role.ts                  // 临时岗位实现
  tool-bundles/
    index.ts
    echo.ts
```

## Acceptance criteria

- [ ] 一个 ws db 中 seed 一个 echo 员工后，Bun server 启动 1 分钟内能在 office_message 表里看到 self 发的至少 1 条消息（心跳触发）
- [ ] admin 给 echo 员工写一条 task（通过 issue 03 endpoint），dispatcher ≤2s 内拉起窗口
- [ ] dispatcher 同时管理 2 个 ws db 时，员工写入归因严格按各自 db 隔离（不可能写到别的 ws db 表里）
- [ ] Bun server 重启后无重复执行：未结 workflow run 通过 `WorkflowsStorage`（在 `_system.workflow_run`）恢复或丢弃
- [ ] 关停时所有员工连接 close 干净
- [ ] **没有任何 SurrealDB 写入使用 root 或 service 身份**（只用员工 SIGNIN 的 token）；root 只在启动枚举 + 取 secret + workflow_run 持久化路径中使用

## Blocked by

- `.scratch/virtual-office/issues/02-office-collaboration-tables.md`
- `.scratch/virtual-office/issues/03-employee-provisioning-endpoint.md`
- `.scratch/agentic-ai-product/issues/10-workflow-run-persistence.md`（`WorkflowsStorage` 实例需迁移到 `_system.workflow_run` 表）

## Notes

- 本 issue 不实现"上级巡检 / 派单逻辑"；echo 岗位只演示心跳通路。
- dispatcher 与 Router workflow 并列存放——前者在 `server/ai/office/`，后者在 `server/ai/mastra/workflows/`。
- **单实例约束**：MVP 后端单副本部署。多 workspace × 多员工 × 多 LIVE 连接的容量上限是首次大客户出现时的重点测试项。
- 触发到表的写入路径不需要 `triggerEmployee` 内部入口——所有写都通过 employee 连接，员工自己的 LIVE 订阅会自然命中下一次循环。
