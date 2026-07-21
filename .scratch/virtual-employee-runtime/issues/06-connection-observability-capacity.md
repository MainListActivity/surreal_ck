Status: ready-for-agent
Label: ready-for-agent

# 06 — 连接监督、观测与容量验收

**What to build:** runtime 可以长期维护员工会话：token 到期前安全续约、网络断开后恢复、启动时分批 reconcile、关停时在截止时间内完成或中止窗口，并向运维暴露不含敏感信息的容量和健康指标。

**Blocked by:** 05 — 预算、循环、重试与全局背压。

**Status:** ready-for-agent

- [ ] token 续约或连接重建后只有一组有效监听和一个员工 session，不产生重复触发。
- [ ] 断线期间已进入持久化队列的 trigger 在恢复后继续执行；LIVE 事件本身不作为唯一持久化来源。
- [ ] 启动时按有界并发枚举 active workspace 和 active 员工，并暴露启动进度与失败计数。
- [ ] shutdown 首先停止接收 trigger，再等待 in-flight 窗口；达到截止时间后发出 abort 并释放 lease，过程不会无限等待。
- [ ] 指标至少覆盖 session、pending trigger、running window、retry、token usage、lease age、reconnect 和 shutdown duration。
- [ ] 日志包含 workspace、employee、trigger 和 run 标识，但不包含 secret、raw token、root 凭证或完整敏感 payload。
- [ ] 确定性虚拟时钟测试覆盖 24 小时运行、预算换日、token 续约和多次暂时断线。
- [ ] 容量测试记录单实例在目标 workspace/employee/trigger 规模下的连接数、吞吐、内存和恢复时间，并给出升级到 leader/sharding 前的阈值。

