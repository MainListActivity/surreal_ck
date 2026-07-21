Status: ready-for-agent
Label: ready-for-agent

# 05 — 预算、循环、重试与全局背压

**What to build:** execution runtime 在无人值守运行前实施硬闸门：每员工每日 token 预算、每窗口步数、trigger chain depth、per-employee 串行、进程级并发上限和有界重试。达到限制时输出一个结构化 runtime signal，业务 adapter 决定如何通知用户。

**Blocked by:** 04 — 可恢复执行窗口与幂等副作用。

**Status:** ready-for-agent

- [ ] 每次模型调用前按剩余额度限制本次最大输出；调用后使用 provider usage 原子累计输入/输出 token。
- [ ] 当 provider 未返回 usage 时使用有界估算并标记计量来源，不能静默记为零。
- [ ] 每日用量按员工和明确业务时区唯一 upsert；日期切换后新一天额度恢复，旧记录保留审计。
- [ ] 超额员工不会再发起模型调用，并且同一天只产生一次 budget-exhausted signal。
- [ ] workflow 循环使用当前 Mastra 支持的 iteration count 或 agent step limit，超过后以明确终态退出。
- [ ] trigger chain depth 由 runtime 继承和递增，调用方不能通过传入较小数字绕过上限。
- [ ] 权限/校验错误不重试；网络、provider 和 rate-limit 错误按有上限的指数退避重试。
- [ ] 事件风暴下同一员工只运行当前窗口和至多一个合并后的后续窗口；全局同时运行数不超过配置值。
- [ ] 测试覆盖额度临界值、单次调用越界、日期切换、递归 trigger、50 条突发事件及暂时性 provider 故障。

