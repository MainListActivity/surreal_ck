Status: ready-for-agent
Label: ready-for-agent

# 04 — 办公室实时花名册与活动页

**What to build:** 建立一个 OfficeDataRuntime 深模块和可用办公室页面：一次性管理初始快照、缓冲 LIVE、RecordId 转换、重连、workspace 切换和清理；页面展示员工花名册、活动流、任务/报告钻取与现有通知收件箱，并通过基础设施生命周期动作暂停、恢复和退休员工。

**Blocked by:** virtual-office/02 — 项目经理派单到报告 tracer.

**Status:** ready-for-agent

- [ ] 页面能从真实 workspace database 显示员工身份/岗位/生命周期、任务状态、消息、报告和通知摘要。
- [ ] LIVE 在初始 snapshot 完成前到达时先缓冲后合并，不丢事件、不重复记录，也不以订阅建立时刻作为数据库真相。
- [ ] workspace 切换和组件卸载会幂等关闭旧订阅；旧 database 的迟到事件无法污染新 workspace 状态。
- [ ] 所有更新操作通过当前浏览器 SurrealDB 封装和正确 RecordId 类型完成，不调用新的 office CRUD 或 LIVE 代理 endpoint。
- [ ] 管理员可从花名册触发 pause、resume、retire；普通成员看不到误导性可用动作，绕过 UI 时仍由后端生命周期规则拒绝。
- [ ] 活动流由任务、消息、报告和通知的持久时间线投影而成，排序稳定，重复 LIVE/reconnect 不产生重复卡片。
- [ ] 报告和任务可钻取到关联上下文；错误、加载、空状态和连接恢复状态都有明确 UI。
- [ ] 浏览器测试覆盖 snapshot/LIVE 竞态、断线重连、快速 workspace 切换、生命周期动作和资源清理。

