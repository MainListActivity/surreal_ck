Status: ready-for-agent
Label: ready-for-agent

# OIP-18 — 每日债权风险提醒 MVP

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

在虚拟办公室 dispatcher 的最小执行链路和用户通知收件箱完成后，增加一个窄的每日检查：读取启用该能力的破产债权工作簿，识别材料缺失、七天内截止和明显金额异常，创建可去重的活动事件或用户通知请求。用户打开提醒时可以查看命中的数据和规则依据，并从当前上下文继续询问 AI。

## Acceptance criteria

- [ ] 每个启用提醒的工作区每天最多完成一次债权风险检查，失败可在下一窗口重试。
- [ ] 检查使用虚拟员工自身的 employee session，绝不使用 root 或 service JWT 读写业务数据。
- [ ] 同一工作簿、记录、风险类型和检查日期不会产生重复提醒。
- [ ] 提醒至少覆盖材料缺失、未来七天截止和金额异常三类确定性规则。
- [ ] 首页活动面板或用户通知收件箱能看到提醒，并可跳转到相关工作簿和记录。
- [ ] 提醒详情展示命中字段、规则和检查时间；AI 解释不得伪造未读取的数据。
- [ ] 未安装破产债权模板包或未启用提醒的工作区不执行该检查。

## Blocked by

- `.scratch/operating-iteration-plan/issues/17-claims-ai-review-tasks.md`
- `.scratch/virtual-office/issues/04-office-dispatcher-tracer.md`
- `.scratch/virtual-office/issues/10-user-notification-inbox.md`
