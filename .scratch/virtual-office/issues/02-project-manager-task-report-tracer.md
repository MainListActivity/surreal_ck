Status: ready-for-agent
Label: ready-for-agent

# 02 — 项目经理派单到报告 tracer

**What to build:** 实现第一个真正的虚拟办公室纵切：管理员已经保存目标和 primary contact 后，项目经理通过通用员工 runtime 被幂等开岗，创建一项有边界的初始任务，发布可见进度，并向 primary contact 交付持久报告。办公室 trigger adapter 负责把领域变化翻译为通用 trigger，不另建 dispatcher。

**Blocked by:** virtual-office/01 — 办公室领域与现有通知兼容闭环；virtual-employee-runtime/05 — 预算、循环、重试与全局背压。

**Status:** ready-for-agent

- [ ] 同一 office bootstrap 请求重试时只得到一个项目经理 employee 和一个初始任务。
- [ ] 项目经理的所有 task/message/report 写入都使用自身 employee session，root 不参与业务写入。
- [ ] 初始任务直接来源于持久 workspace goal，具备明确完成条件、合法 assignee、parent/depth 和稳定幂等键。
- [ ] 新任务、任务状态和定期 reconciliation 都通过 office trigger adapter 投递到通用 runtime；代码中不存在第二套会话池、预算器或运行循环。
- [ ] 一次健康执行产生至少一条可见进度和一份关联初始任务、发给 primary contact 的持久报告。
- [ ] 重放相同 trigger、workflow step 或报告副作用不会产生重复用户可见任务或报告。
- [ ] 项目经理尝试超过 delegation depth、指派给不存在/暂停员工或执行 DDL 时被领域或数据库边界拒绝，并形成可诊断结果。
- [ ] 真实 SurrealDB 纵切测试从 goal 开始，以 primary contact 可读取报告结束；现有 Router 与债权风险员工测试保持通过。

