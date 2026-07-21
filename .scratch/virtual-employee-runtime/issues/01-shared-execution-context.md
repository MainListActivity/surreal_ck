Status: ready-for-agent
Label: ready-for-agent

# 01 — 共享执行上下文 seam，保持 Router 零回归

**What to build:** 把 Mastra tool 取得 SurrealDB 会话的方式从 Router 专属运行时中抽离为共享执行上下文。现有 Router workflow 的行为、权限和流式结果保持不变，同时员工 workflow 可以通过同一 seam 注入自己的 employee session。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 所有现有 tool 只通过共享执行上下文取得本次 run 的 SurrealDB 会话。
- [ ] 缺少会话时 tool 明确失败，且不存在 root、全局连接或其它身份兜底。
- [ ] 两个并发 Router run 注入不同会话时，查询和写入不会串台。
- [ ] 一个最小 employee run 能通过同一 seam 使用 employee session 调用只读测试 tool。
- [ ] 现有 Router workflow、tool session、暂停/恢复和调用者归因测试全部保持通过。

