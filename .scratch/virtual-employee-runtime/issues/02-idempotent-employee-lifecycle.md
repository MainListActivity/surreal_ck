Status: ready-for-agent
Label: ready-for-agent

# 02 — 幂等虚拟员工生命周期与会话注册

**What to build:** 工作区管理员可以幂等地创建、暂停、恢复和退休虚拟员工；运行时会随生命周期变化注册或关闭该员工的 employee session。员工身份写入使用管理员会话，root 只处理 workspace 索引和员工凭证。

**Blocked by:** 01 — 共享执行上下文 seam，保持 Router 零回归。

**Status:** ready-for-agent

- [ ] 创建请求携带稳定幂等键；请求超时后重试返回同一员工，不产生第二条员工或凭证记录。
- [ ] 目标 workspace 必须与调用者 token 的 database/access scope 一致；participant 或其它 workspace token 被拒绝。
- [ ] 所有路由 RecordId 在数据库边界转换为 RecordId 类型，不把裸字符串作为 record 字段传入。
- [ ] 员工记录成功而凭证写入失败时会补偿或留下可安全重试的失败状态，不出现看似 active 但无法 SIGNIN 的员工。
- [ ] 创建或恢复 active 员工后，运行时无需重启即可注册其 session；暂停或退休后不再接受新执行窗口并关闭现有连接。
- [ ] 退休会旋转凭证并记录短 token 的剩余有效窗口；不会把 secret、token 或 root 凭证返回给浏览器或写入日志。
- [ ] 生命周期测试覆盖重复请求、并发请求、部分失败和所有合法/非法状态转换。

