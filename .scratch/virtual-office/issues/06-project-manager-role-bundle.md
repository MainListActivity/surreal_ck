Status: needs-triage
Label: needs-triage

# VO-06 — 项目经理 岗位与 tool bundle

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

把 echo tracer 替换为 MVP 的第一个真实 **岗位**："项目经理"。它能：

1. 读自己工作区的 `workspace.goal`（issue 11 会在 workspace 上加 `goal` 字段，本 issue 暂用 `workspace.name` 或 `office_role.system_prompt` 内 baked 的目标兜底）
2. 浏览工作区当前所有 **数据表** 与 **派单** 状态（read-only 调用既有 navigation tool）
3. 给自己或其它员工 **派单**
4. 给 owner 写 **汇报**
5. 在需要时发 **用户通知请求**

### 三件套 tool（新建 bundle `manager-basics`）

新增 `server/ai/office/tool-bundles/manager-basics.ts`：

```ts
createOfficeTaskTool          // input: { assignee, goal, parent_task?, due_at? }
postOfficeReportTool          // input: { to, task?, summary, next_steps?, blocked_by? }
postUserNotificationTool      // input: { severity, body, requested_action? }
```

所有 tool 内部用员工自己的 SurrealDB 连接（dispatcher 维护的 employee session）写入，归因由 SurrealDB `$auth` 自动注入；Tool input zod schema 不接受 `from`/`assigner`/`from_employee` 字段，让 PERMISSIONS（issue 02 已写）兜底拒绝任何冒名顶替。**不存在 service 连接**——本 ADR 链路全程不使用 service 身份。

### Seed

dispatcher 启动时若工作区无任何 `office_role.key='project-manager'`，自动 seed 一条（system_prompt 在文件常量里）。issue 11 onboarding 后改为显式 wizard 引导。

### 心跳行为

每个心跳：

1. SELECT 本人 in-flight `office_task` open + in_progress
2. 对最旧的一条调一次 workflow：让 LLM 决定"继续做 / 派给别人 / 写 report 暂停"
3. 同时 SELECT 下属（按 `virtual_profile.supervisor = self`）的 stalled / overdue 任务
4. 若有，发 message 催办（不重复发——24h 去重，由 tool 内部检查最近消息）

## Acceptance criteria

- [ ] 项目经理被创建后，能在心跳触发时写出至少一条 `office_report` 给 owner
- [ ] 项目经理收到一条 `office_task { goal: '调查 X' }` 后，要么完成（写 result），要么派给其它员工（创建子 task），要么写 report 说明"无可用员工"
- [ ] 三件套 tool 的 input zod schema 完备；空字符串、跨工作区 assignee 会被 tool 内部预检拦下
- [ ] 集成测试：seed manager + 写一条 task → dispatcher 拉起窗口 → 表中出现 report 或子 task

## Blocked by

- `.scratch/virtual-office/issues/04-office-dispatcher-tracer.md`

## Notes

- 系统提示模板放 `office_role.system_prompt` 字段而非代码常量——为后续"用户自定义岗位"留口。但本 issue 内仍用代码常量作为 seed 来源。
- 项目经理 MVP 不调用 dashboard / claim-analysis tool，只负责调度。issue 07/08 引入数据分析师 + 表单专员后才有"被派的人"。
