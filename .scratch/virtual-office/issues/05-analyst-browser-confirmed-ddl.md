Status: ready-for-agent
Label: ready-for-agent

# 05 — 数据分析师提出、浏览器管理员确认 DDL

**What to build:** 增加数据分析师角色的首个纵切。分析师使用 employee session 检查数据并提出限定类型的持久 DDL intent；管理员在办公室 UI 查看实际变更、理由和影响后确认或拒绝。确认后由当前浏览器 admin SurrealDB 会话执行，结果持久化并一次性唤醒分析师继续任务。

**Blocked by:** virtual-office/03 — 人类请求一次性解决闭环；virtual-office/04 — 办公室实时花名册与活动页。

**Status:** ready-for-agent

- [ ] 项目经理能按稳定请求键幂等开岗一个数据分析师并指派真实分析任务；重试不产生重复员工。
- [ ] 分析师的读写和 permitted DML 使用自身 employee session；分析师无法直接执行 DDL 或获得任何真人/root 凭证。
- [ ] 第一版 DDL intent 只允许明确列出的非破坏性表、字段和索引定义操作，保存规范化变更、可读理由、预期影响和稳定 fingerprint；任意原始批量语句与 REMOVE 不在范围内。
- [ ] DDL intent 与通用 notification 关联，只有当前 workspace 的 admin access 能进入确认执行；participant 绕过 UI 仍被数据库拒绝。
- [ ] 浏览器通过当前数据库/数据表 runtime 使用现有 SurrealDB 连接执行确认后的 DDL，不新增后端 DDL 代理，也不把 issuer session 传给 dispatcher。
- [ ] approved、executing、succeeded、rejected、failed 和 ambiguous/reconciled 路径都有持久结果；终态 intent 刷新或重试不会执行第二次。
- [ ] 执行结果通过 office trigger adapter 以稳定幂等键唤醒分析师；分析师据此提交报告或提出修订 intent。
- [ ] 端到端测试覆盖 admin 成功、participant 被拒、用户拒绝、数据库失败、执行中刷新和结果后 workflow 恢复。

