Status: ready-for-agent
Label: ready-for-agent

# 01 — 办公室领域与现有通知兼容闭环

**What to build:** 以 workspace 模板增量建立最小办公室领域：元数据、任务、消息、报告和 DDL intent；扩展现有 `user_notification` 成为通用人类注意力通道，同时保证已上线的每日债权风险提醒和收件箱不变。提供项目经理、数据分析师两个默认岗位定义，并用真实三类会话证明权限边界。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 新旧 workspace 都能幂等获得项目经理和数据分析师岗位定义，不创建员工实例或凭证。
- [ ] 管理员可写办公室目标和有效 primary contact；普通成员和虚拟员工不能篡改办公室所有权元数据。
- [ ] 员工可按权限创建任务、消息、报告、通知和 DDL intent，所有写入都由 `$auth` 归因且不出现手工 `from_*` 身份字段。
- [ ] task 的 assigner、assignee、parent、depth 与创建元数据，message/report 的 author 与 task 关联，以及 notification 的 sender/recipient/payload 在创建后不可被改写。
- [ ] task、notification 和 DDL intent 的状态迁移受 schema 权限和状态约束保护；客户端查询不添加冗余 auth WHERE 条件。
- [ ] 现有债权风险通知 fixture 可无损迁移，当前风险收件箱仍能显示、解决并保持原去重语义。
- [ ] admin、participant、employee 三类真实会话集成测试覆盖允许操作、越权拒绝、RecordId/日期类型和两个 workspace database 的天然隔离。

