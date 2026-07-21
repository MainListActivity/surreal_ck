Status: ready-for-agent
Label: ready-for-agent

# 03 — 通用持久化触发接管每日债权风险员工

**What to build:** 建立不依赖办公室领域表的通用员工 runtime。现有每日债权风险调度改为 trigger adapter：定时观察只负责投递持久化触发，runtime 负责 employee SIGNIN、执行窗口、结果和关停，用户继续收到与当前相同的风险提醒。

**Blocked by:** 02 — 幂等虚拟员工生命周期与会话注册。

**Status:** ready-for-agent

- [ ] trigger adapter 能以员工、原因、payload 引用、chain depth 和幂等键投递持久化触发。
- [ ] 同一工作区同一天的债权风险触发重复投递时只产生一次用户可见检查结果。
- [ ] runtime 不查询或写入 office task、message、report、goal 等虚拟办公室领域数据。
- [ ] 风险检查的所有业务写继续使用 employee session，root 仅用于允许的启动枚举和凭证维护。
- [ ] 两个 workspace 的风险员工由各自 database/session 执行，数据和身份归因严格隔离。
- [ ] 启动和停止通过小 Interface 完成；停止后不会再接收新 trigger，并会关闭已打开的员工会话。
- [ ] 现有每日风险提醒、通知收件箱和 dispatcher 行为测试保持通过。

