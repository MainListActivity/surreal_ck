Status: done
Label: done

# 03 — 人类请求一次性解决闭环

**What to build:** 让项目经理或其他虚拟员工能发出结构化人类请求，并在现有通知收件箱中等待。收件人提交答案、拒绝或取消后，结果持久化并通过 office trigger adapter 恰好唤醒一次逻辑后续执行；每日债权风险提醒继续使用同一收件箱。

**Blocked by:** virtual-office/02 — 项目经理派单到报告 tracer.

**Status:** done

- [x] 虚拟员工可创建带 task/run 关联、问题类型、提示内容和目标 recipient 的通用通知请求。
- [x] 请求出现在现有通知收件箱，债权风险与员工请求有各自清晰呈现，但不形成第二套 inbox/store。
- [x] 只有目标 recipient 或 schema 明确允许的管理员能写 resolution；sender、recipient、问题 payload 和创建时间不可改写。
- [x] answer、reject、cancel 都形成持久终态，重复点击、刷新重试和重复 LIVE 事件不改变首个合法终态。
- [x] resolution 先提交数据库，再通过 office trigger adapter 以稳定幂等键唤醒 requesting employee；从用户视角只继续一次。
- [x] 服务或浏览器在 resolution 与唤醒之间崩溃后，reconciliation 能补投 trigger，不需要重新回答。
- [x] UI 显示待处理、已解决和失败状态；结构化错误不会把实际未提交的答案显示为成功。
- [x] 集成测试覆盖 employee 提问、participant 回答、非 recipient 越权、断线重连和债权风险通知兼容。


## Comments

- 2026-10-01：工程复核退回的续跑恢复缺陷已修复。新增真实 fork + Mastra snapshot 的四个中断点回归，使用 waiting_on/requestId 识别同一请求的持久中间态；其他请求、assignee 或取消终态不可被收尾。测试 fixture 使用 ES256 静态公钥以兼容本机未启用 JWKS 的 fork 构建，生产 JWT/JWKS access 定义保持原样。
