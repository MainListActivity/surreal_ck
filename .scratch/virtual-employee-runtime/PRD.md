# 虚拟员工执行基础设施 PRD

更新时间：2026-07-19

Status: ready-for-agent
Label: ready-for-agent

## Problem Statement

代码库已经具备 workspace database、三类 SurrealDB access、虚拟员工身份、员工凭证、Mastra workflow 持久化和一个专用的每日债权风险 dispatcher，但这些能力仍由具体业务各自装配。若直接继续建设虚拟办公室，员工会话、触发、恢复、预算、连接续约和优雅关停会散落到岗位与办公室业务中，后续每新增一种自治员工都要重复解决同一组基础设施问题。

系统需要一个不理解“派单、汇报、办公室消息”等产品概念的深 Module，统一承载虚拟员工的生命周期和自治执行。业务需求只负责把领域事件适配成执行触发，并提供本次执行所需的岗位逻辑。

## Solution

建设“虚拟员工执行基础设施”，为每个 workspace database 内的虚拟员工提供：幂等生命周期、employee access 会话、持久化触发、串行执行窗口、Mastra workflow 恢复、预算与循环闸门、连接监督、全局背压、观测和优雅关停。

基础设施通过一个小 Interface 接收“哪个员工因什么原因需要运行”，通过 adapter 装载生产 SurrealDB 会话或测试替身。它不查询或写入虚拟办公室领域表；虚拟办公室、每日债权风险检查及未来自治能力分别提供 trigger adapter 和岗位实现。

执行语义明确为至少一次：触发可能被重复投递，但执行认领和所有有副作用的动作必须幂等。服务重启后，已持久化触发和 workflow run 可以恢复，不能通过静默丢弃来满足“不重复”。

## User Stories

1. As a workspace administrator, I want a virtual employee to be provisioned idempotently, so that retrying a timed-out request does not create duplicate employees.
2. As a workspace administrator, I want to pause a virtual employee, so that no new execution window starts while I investigate its behaviour.
3. As a workspace administrator, I want to resume a paused virtual employee, so that pending work can continue without recreating the employee.
4. As a workspace administrator, I want to retire a virtual employee, so that its credential and runtime connections stop being usable for new work.
5. As a product developer, I want employee credentials to remain root-maintenance data, so that no browser or ordinary employee session can read them.
6. As a product developer, I want all business writes from an employee run to use that employee's RECORD session, so that SurrealDB attributes changes to the real virtual employee.
7. As a product developer, I want to submit a typed employee trigger without knowing connection or workflow internals, so that new autonomous products reuse the same runtime.
8. As a product developer, I want different trigger adapters to share the runtime, so that scheduled checks and LIVE-driven work do not create parallel dispatchers.
9. As an operator, I want triggers persisted before execution, so that a process crash cannot lose accepted work.
10. As an operator, I want duplicate triggers coalesced by an idempotency key, so that reconnects and repeated LIVE events do not multiply work.
11. As an operator, I want only one execution window per employee at a time, so that the same identity cannot race itself.
12. As an operator, I want a global concurrency ceiling, so that a restart or event storm cannot launch every employee simultaneously.
13. As an operator, I want transient failures retried with bounded backoff, so that provider or network outages do not create a tight loop.
14. As an operator, I want permanent failures surfaced without retry storms, so that invalid configuration is actionable.
15. As a workspace administrator, I want each employee's daily token usage bounded, so that unattended execution cannot exhaust the budget.
16. As a workspace administrator, I want a single budget-exhausted signal, so that repeated heartbeats do not flood the notification system.
17. As a product developer, I want execution-window step and trigger-chain depth limits, so that recursive delegation terminates predictably.
18. As an operator, I want an active workflow run to restart from its last durable state after a crash, so that recovery behaviour is explicit.
19. As an operator, I want suspended and active workflow runs recovered differently, so that human-input waits are not mistaken for crashed executions.
20. As an operator, I want storage failures to stop the employee window, so that a missing snapshot cannot silently start duplicate work.
21. As an operator, I want employee sessions to renew and reconnect without duplicating subscriptions or runs, so that long-lived workers remain healthy.
22. As an operator, I want shutdown to stop accepting triggers and finish or abort in-flight windows within a deadline, so that deployments do not hang indefinitely.
23. As an operator, I want workspace, employee, run and trigger identifiers in metrics and logs without secrets, so that incidents can be diagnosed safely.
24. As a maintainer, I want the existing daily debt-risk employee to run through the generic runtime, so that the migration proves real compatibility rather than only an echo demo.
25. As a tester, I want production SurrealDB and in-memory adapters behind the same seam, so that recovery and concurrency can be tested deterministically.

## Implementation Decisions

- The runtime is a deep Module. Its external Interface covers lifecycle registration, trigger enqueueing, reconciliation, start and stop. Connection pools, leases, retries, workflow construction and token accounting remain Implementation details.
- The shared Mastra execution context is independent of Router workflow terminology. Router runs and employee runs inject their own SurrealDB session through the same internal seam; tools fail closed when the session is absent.
- A virtual employee remains a workspace-local `user` record with `kind='virtual'` and uses the existing employee RECORD access. No service JWT or long-lived employee JWT is introduced.
- Root access is limited to workspace enumeration, lifecycle maintenance and employee credentials. Workflow snapshots, token usage and all domain writes use the employee session.
- Lifecycle mutations are idempotent. Provisioning accepts a stable request key; a retry returns the previously created employee. Partial failure between the employee record and credential write is compensated or left in a durable failed lifecycle state that can be retried safely.
- The runtime owns a workspace-local durable trigger queue. Trigger adapters translate external observations into a stable employee, reason, payload reference, chain depth and idempotency key. Large domain payloads are referenced rather than copied into workflow snapshots.
- Delivery is at least once. A trigger has explicit pending, leased, running, waiting, completed and failed states. Leases expire, but effect idempotency prevents a reclaimed run from duplicating completed side effects.
- An employee has at most one active execution window. A process-wide semaphore limits concurrent employees; additional triggers are marked pending and coalesced rather than launched concurrently.
- Mastra suspended runs resume from snapshots. Runs that were active when the process disappeared use the installed Mastra restart capability. The storage adapter operates in strict mode for employee runs and never degrades a failed load to a fresh run.
- Workflow kind and run ownership are persisted consistently. Employee runs use one stable workflow identifier understood by the storage adapter and schema.
- Every external side effect receives a stable idempotency key derived from the trigger and logical action. Retrying a workflow step must return the prior result when that effect already committed.
- Budget enforcement combines a preflight remaining-budget calculation, a per-call maximum output, actual provider usage accounting and a bounded fallback estimate. Usage writes use the existing unique-key upsert convention.
- The budget day uses an explicit configurable business timezone. A workspace-specific timezone may be added later; the initial deployment default is documented and tested.
- Step limits use the installed Mastra APIs: workflow-loop conditions use the provided iteration count, while agentic calls use their supported step limit. No nonexistent workflow option is assumed.
- Retry policy classifies permission and validation errors as permanent, and provider/network/rate-limit errors as transient. Backoff has a maximum attempt count and jitter.
- Trigger adapters, session factories, clock, usage meter and workflow runner are real seams because production and test adapters both exist. Internal helper seams are not exposed through the runtime Interface.
- The current daily debt-risk scheduler becomes the first production trigger adapter. Its existing user-visible reminders and once-per-day deduplication remain unchanged.
- The infrastructure does not depend on office task, report, message, goal, role bundle or UI concepts. Those belong to the virtual-office requirement.
- Operational metrics cover active sessions, pending triggers, running windows, retries, token usage, lease age, reconnects and shutdown duration. Logs never include root credentials, employee secrets or raw tokens.

## Testing Decisions

- Tests assert behaviour through the runtime Interface and production-like adapters; they do not inspect private maps or timers.
- The shared execution-context seam is tested first by proving all existing Router tools still use the caller session and concurrent runs do not cross sessions.
- Lifecycle tests cover request retries, partial failures, pause/resume/retire transitions, RecordId conversion and dynamic session registration.
- A real SurrealDB integration test verifies employee SIGNIN, workspace isolation, trigger persistence, lease acquisition and employee-attributed writes.
- Recovery tests crash an execution at several durable boundaries, construct a new runtime instance and verify that the trigger completes exactly once from the user's perspective.
- Suspend/resume and active-run restart have separate tests because their Mastra semantics differ.
- Event-storm tests enqueue repeated and distinct triggers, proving per-employee serialization, idempotent coalescing and the global concurrency ceiling.
- Budget tests use exact provider usage, missing usage fallback, day rollover in the configured timezone and a single budget-exhausted signal.
- Reconnect tests rotate sessions and prove that no duplicate listener or execution window remains.
- Shutdown tests use a deterministic clock and abort signal, proving the runtime stops accepting work and respects its deadline.
- Existing daily debt-risk dispatcher, notification and workflow-storage tests are prior art and must remain green during the migration.
- A deterministic virtual-clock scenario covers 24 hours of heartbeats, retries and budget rollover. A documented manual soak complements it before production rollout.

## Out of Scope

- Office task, report and message schemas.
- Project-manager, data-analyst or form-officer behaviour.
- Office roster, activity stream, task board or onboarding UI.
- Human approval and execution of DDL intents.
- Public form publishing and anonymous form submissions.
- Multi-process leader election and horizontal dispatcher sharding.
- Cross-workspace employee transfer or shared employee identity.
- Mobile push notifications.

## Further Notes

- This requirement is the foundation consumed by the virtual-office requirement; it is not itself a user-facing office product.
- The first implementation frontier is the shared execution-context prefactor. It preserves current behaviour while creating the seam needed by every later ticket.
- The existing daily debt-risk flow is intentionally used as the first production tracer instead of adding an echo-only parallel dispatcher.
- The virtual-office ADR remains Proposed until this runtime contract and the product-level durable DDL intent flow are reflected in it.

