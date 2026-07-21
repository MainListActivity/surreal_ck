# 虚拟办公室产品 PRD

更新时间：2026-07-19

Status: ready-for-agent
Label: ready-for-agent

## Problem Statement

当前产品已经有 workspace database、浏览器直连 SurrealDB、真人与虚拟员工身份、AI Router、每日债权风险员工和通知收件箱，但还没有一个用户能够理解和管理的“办公室”。用户无法把工作区目标交给虚拟项目经理，观察任务如何拆解和推进，也没有安全、持久的机制处理员工提出的澄清请求或数据库结构变更。

原虚拟办公室规划同时承担了员工会话、dispatcher、恢复、预算、办公室业务表、岗位行为和前端 UI，导致需求边界过宽，并与已经落地的债权风险 dispatcher、通知模型和浏览器数据访问接口发生重叠。虚拟员工的通用运行时现已拆入独立的“虚拟员工执行基础设施”需求；本需求只定义用户可见的办公室产品及其领域规则。

## Solution

建设一个由虚拟项目经理和虚拟数据分析师组成的最小可用办公室。工作区管理员设置目标并完成可选数据导入后，系统幂等开岗项目经理；项目经理创建和委派持久任务，员工通过消息请求信息，通过报告交付结果。前端以一个办公室页面呈现花名册、活动流、任务状态、报告和现有通知收件箱。

虚拟办公室通过 trigger adapter 使用“虚拟员工执行基础设施”。办公室领域事件先持久化，再被翻译为员工触发；LIVE 只负责低延迟唤醒和 UI 更新，不作为唯一事实来源。所有员工业务写入继续使用各自的 employee session。

数据分析师不能在后台借用真人会话执行 DDL。分析师只提交持久化 DDL intent，由指定工作区管理员在浏览器中查看并确认；浏览器使用当前 admin SurrealDB 会话执行结构变更，再持久化结果并唤醒员工。普通成员即使能看见相关通知，也无法越过数据库 access 执行 DDL。

## User Stories

1. As a workspace administrator, I want to state the workspace goal, so that the virtual office works toward an explicit outcome.
2. As a workspace administrator, I want to import initial data or explicitly skip import before work begins, so that employees do not analyse an incomplete setup by accident.
3. As a workspace administrator, I want office bootstrap to be idempotent, so that refreshing or retrying onboarding does not create duplicate employees or initial tasks.
4. As a workspace administrator, I want a virtual project manager to become the first employee, so that there is one accountable coordinator for the goal.
5. As a workspace administrator, I want the original office owner recorded as the primary human contact, so that autonomous work always has a durable escalation target.
6. As a workspace administrator, I want to see the employee roster and lifecycle state, so that I know who is active, paused or retired.
7. As a workspace administrator, I want to pause, resume or retire an employee, so that I can control autonomous activity without deleting its history.
8. As a workspace member, I want to see an ordered activity stream, so that I can understand what the office has recently done.
9. As a workspace member, I want to see tasks and their current status, so that progress is inspectable rather than hidden in chat transcripts.
10. As a workspace member, I want to open a task and read its messages and reports, so that evidence and decisions remain attached to the work.
11. As a virtual project manager, I want to decompose the workspace goal into bounded tasks, so that work can proceed incrementally.
12. As a virtual project manager, I want parent and depth constraints on delegated tasks, so that recursive delegation cannot grow without limit.
13. As a virtual project manager, I want to assign work only to supported active roles, so that a task is not sent to a nonexistent or paused employee.
14. As a virtual employee, I want to post progress messages and a final report, so that humans and other employees can consume my output asynchronously.
15. As a virtual employee, I want to ask a human a structured question, so that missing information does not force me to guess.
16. As a human recipient, I want employee requests in the existing notification inbox, so that there is one attention surface rather than competing inboxes.
17. As a human recipient, I want resolving a notification to wake the requesting employee exactly once, so that retries do not duplicate follow-up work.
18. As a maintainer, I want existing debt-risk reminders to remain readable and actionable, so that generalising notifications does not regress shipped behaviour.
19. As a virtual data analyst, I want to inspect workspace data and run permitted DML through my own employee session, so that analysis is correctly attributed.
20. As a virtual data analyst, I want to propose a typed DDL intent when the goal requires schema changes, so that the requested change is explicit and reviewable.
21. As a workspace administrator, I want to review the purpose and impact of a DDL intent before confirming it, so that autonomous schema changes remain human-controlled.
22. As a workspace administrator, I want confirmed DDL to run in my current browser database session, so that only the admin access receives DDL capability.
23. As a virtual data analyst, I want the durable DDL result to wake my task, so that I can continue after success or revise the plan after failure or rejection.
24. As an ordinary workspace member, I want the database to reject DDL even if UI state is manipulated, so that authorization does not depend on a button.
25. As a user switching workspaces, I want office subscriptions and state to switch cleanly, so that records from different workspace databases never mix.
26. As a user reconnecting after network loss, I want the office snapshot and later LIVE events merged without gaps or duplicates, so that the UI converges to database truth.
27. As a user, I want first visible progress soon after onboarding and a substantive first report under healthy dependencies, so that the office feels active and useful.
28. As a tester, I want the office product usable against a real SurrealDB and deterministic runtime adapters, so that permissions, recovery and UI behaviour are testable at the correct boundaries.

## Implementation Decisions

- This requirement consumes the virtual-employee-runtime Interface for lifecycle and triggers. It does not implement its own session pool, dispatcher, leases, retry loop, token budget or shutdown manager.
- The first supported role bundles are project manager and data analyst. Role definitions are workspace template data and are seeded idempotently; employee instances remain workspace-local `user` records with `kind='virtual'`.
- A workspace-local metadata record stores the office goal, primary human contact and bootstrap state. Bootstrap records the initiating administrator as primary contact unless a valid primary contact already exists; retries preserve the original owner rather than silently replacing it.
- The office domain consists of persistent tasks, messages, reports and DDL intents. Existing `user_notification` is extended into the common human-attention channel rather than replaced by a second inbox or a parallel notification table.
- Every domain record has a stable creator/sender/assigner identity and immutable creation metadata. Resolution and lifecycle transitions are modelled as explicit fields with schema-level permissions; client queries do not duplicate authorization filters.
- Task assignment, parentage and delegation depth are immutable after creation. Status changes follow a documented state machine. Terminal tasks cannot be reopened by a retry unless an explicit future product action permits it.
- Messages and reports are append-oriented. Their author, task association and payload cannot be rewritten after publication. Corrections are new records linked to the prior result.
- Notifications support multiple typed purposes while preserving existing debt-risk fields and behaviour. The recipient owns human resolution fields; the employee owns request creation; terminal resolution is idempotent.
- DDL intent is a durable domain entity with requested, approved, executing, succeeded, rejected and failed outcomes. It stores a typed operation, human-readable rationale, expected impact, a stable fingerprint and execution result; it never stores a reusable human credential.
- Background employees never receive or cache an issuer's browser session. Confirmation occurs in the browser and executes through the current data-table/database runtime with the current SurrealDB connection. Database access type remains the final DDL guard.
- Retrying DDL confirmation checks the intent fingerprint and current schema/result state before applying an effect. A terminal intent is not executed again. Ambiguous outcomes are reconciled and shown to the administrator instead of guessed by the employee.
- Office events are persisted before trigger enqueueing. Trigger adapters cover new/changed assignments, office messages, resolved notifications, DDL results and periodic reconciliation. LIVE is an accelerator; startup reconciliation closes missed-event gaps.
- The project manager creates the first real task from the stored goal. The success tracer is task creation, visible progress and a durable report to the primary human contact—not an echo-only workflow.
- The project manager may add the data analyst only when work needs that role. Provisioning uses the infrastructure's idempotent lifecycle operation and a stable request key derived from the office and role.
- The frontend owns an OfficeDataRuntime-style deep module that encapsulates initial snapshot plus buffered LIVE subscriptions, RecordId conversion, merge ordering, structured errors, workspace switching and idempotent cleanup.
- Office UI reuses the shipped notification inbox and its risk reminder presentation. New employee questions and DDL approvals are new notification variants in the same attention model.
- Onboarding reuses the existing workspace creation and token-switch flow. After the browser is signed into the new database, it writes goal/primary contact, completes or skips import, then invokes one idempotent office bootstrap action. The first task is not created before the import barrier reaches a terminal state.
- UI capability hints may hide unavailable actions, but backend lifecycle rules and SurrealDB access/permissions remain authoritative. The product does not treat a client-side `can_create_workspace` value as a security control.
- Product targets are first visible progress within 30 seconds of an accepted initial task and a substantive first report within 5 minutes under healthy database/model dependencies. Operational alerts distinguish dependency failure from employee inactivity.

## Testing Decisions

- Schema integration tests use real admin, participant and employee sessions to prove permitted creates/transitions, immutable fields, workspace isolation and DDL rejection for non-admin access.
- Backward-compatibility fixtures cover existing debt-risk notifications before and after the notification migration; the current inbox behaviour remains green.
- Project-manager tests begin from a stored goal and assert a bounded task, progress event and durable report through public domain/runtime Interfaces.
- Notification tests cover create, display, resolve, reconnect and repeated resolution, proving that the requesting employee receives one logical wake-up.
- DDL tests cover approve, reject, execution failure, refresh during execution and retry after an ambiguous response. They prove no employee session or participant session can perform the DDL.
- OfficeDataRuntime tests deliberately deliver LIVE events before the initial snapshot finishes, after reconnect and during workspace switch; the final state must contain no gap, duplicate or cross-workspace record.
- UI tests verify roster lifecycle actions, task drill-down, activity ordering, notification variants and structured error states without asserting private store implementation.
- Onboarding end-to-end tests cover successful import, skipped import, failed import, refresh/retry at every step and an already-bootstrapped workspace. Exactly one manager and one initial task are created.
- A production-like end-to-end tracer starts from workspace creation, reaches the first report, requests a human answer and completes one analyst DDL intent using a real SurrealDB database.
- Performance acceptance measures first visible progress and first report under documented healthy test conditions; elapsed-time assertions use controlled clocks below the browser boundary where practical.

## Out of Scope

- Employee session pooling, trigger leases, workflow recovery, retry policy, budget accounting, global concurrency, connection supervision and graceful shutdown; these belong to virtual-employee-runtime.
- Form-officer role, public form publishing, anonymous submissions and `/forms/:id`; these require a separate forms product requirement and security decision.
- Autonomous execution of DDL without an active human administrator confirmation.
- Arbitrary user-authored role bundles or a role marketplace.
- Multi-agent chat rooms, voice/video presence or spatial office simulation.
- Cross-workspace tasks, employees or reports.
- Mobile push, email or external chat notifications.
- Approval of destructive data migrations beyond the typed DDL operations explicitly supported by the first analyst flow.

## Further Notes

- This PRD supersedes the earlier mixed virtual-office plan and deliberately removes infrastructure tickets from this requirement.
- The accepted architecture remains browser-direct for business reads, writes, LIVE and admin DDL. The Bun server only supplies the generic employee runtime and existing narrow lifecycle/AI endpoints; it does not become an office CRUD or LIVE proxy.
- The existing daily debt-risk employee is prior art and the first infrastructure adopter, not a virtual-office product role.
- The virtual-office ADR remains Proposed. It should be revised to reflect the split, common notification model and durable browser-confirmed DDL intent before the feature is declared production-ready.
