Status: ready-for-agent
Label: ready-for-agent

# 04 — 可恢复执行窗口与幂等副作用

**What to build:** 每个持久化触发通过有 lease 的执行窗口运行并关联一个 durable workflow run。进程崩溃后，新的 runtime 能区分 active、waiting 和 suspended 状态，重启或恢复正确的 run；重复认领不会造成重复业务副作用。

**Blocked by:** 03 — 通用持久化触发接管每日债权风险员工。

**Status:** ready-for-agent

- [ ] 触发具有 pending、leased、running、waiting、completed 和 failed 等可观察状态，并记录 lease 到期时间与尝试次数。
- [ ] 同一员工同一时刻至多有一个 active 执行窗口；额外 trigger 保持 pending 或按幂等键合并。
- [ ] active run 在进程丢失后使用 Mastra 的 active-run restart 语义，显式 suspended run 只通过 resume 语义恢复。
- [ ] employee workflow storage 读取或写入失败时窗口 fail-closed，不会把缺失 snapshot 当成新 run。
- [ ] 每个有副作用的 tool 使用稳定 effect key；崩溃发生在“效果已提交、snapshot 未更新”之间时，恢复后返回既有结果而不重复写入。
- [ ] 触发、workflow run 和 effect 记录都归属当前 workspace database，并由 employee session 写入。
- [ ] 集成测试在认领前、认领后、tool 提交后和 workflow 完成前模拟崩溃，最终用户可见效果均只出现一次。

