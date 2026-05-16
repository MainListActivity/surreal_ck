Status: needs-triage
Label: needs-triage

# VO-10 — 用户通知请求 inbox + 闭环

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

把 **用户通知请求** 接入既有 AI 抽屉，让用户在一个地方处理"虚拟员工说我该出手了"的事情。

### 抽屉 tab 增量

AI 抽屉新增 "通知" tab，与现有 "对话" tab 并列：

- 后端 WS endpoint 转发 `LIVE SELECT * FROM user_notification WHERE to_user = $auth AND resolved_at = NONE`
- 列表卡片：severity 色带、from_employee avatar、body、`requested_action`
- 卡片底部三按钮：
  - **已完成**：弹小输入框收 `resolution` 文本 → 调后端 endpoint
  - **稍后再说**：把卡片折叠到底部，不写库
  - **打开任务**：若 notification 关联了 task，跳转到办公室页对应卡片

### 后端 HTTP endpoint

- `POST /api/workspaces/:slug/office/notifications/:id/resolve` body: `{ resolution }`：
  1. 用调用者 OIDC JWT SIGNIN 到 `ws_<slug>` db；access AUTHENTICATE 自动校验工作区成员身份
  2. UPDATE `user_notification` 写入 `resolution + resolved_at`；PERMISSIONS 自动校验 `to_user = $auth` 或 `is_admin`
  3. 不需要显式触发 dispatcher——发起方员工的 LIVE 订阅（`from_employee = $auth AND resolved_at != NONE`）会自然命中下一次执行窗口
- 不需要 `dismiss` endpoint——折叠是前端纯 UI 状态。

### 后续连锁反应

resolution 写库后，发起方员工的下一次心跳会读到 `resolution != NONE`，自然在 workflow 里看到"用户回复了"——这是 issue 06/07/08 各自岗位 system prompt 的责任，本 issue 不实现具体反应逻辑。

## Acceptance criteria

- [ ] 表单专员发出一条 `severity='urgent'` 通知，5s 内出现在用户抽屉 tab，带未读红点
- [ ] 用户点"已完成"+ 填 resolution → 库里看到 `resolved_at` 已写、`resolution` 文本一致
- [ ] resolution 写入后，发起方员工的下一次心跳在 workflow context 中读到该 resolution（通过 manager-basics 的 read tool 暴露 `getNotificationStatus`）
- [ ] 非 owner 但属于 workspace 的 member 看不到 owner-only 的通知（不该看到的看不到）

## Blocked by

- `.scratch/virtual-office/issues/02-office-collaboration-tables.md`
- `.scratch/virtual-office/issues/09-office-ui-roster-and-activity-stream.md`

## Notes

- 通知的 "打开任务" 跳转需要前端路由参数承接；本 issue 在 office UI 侧加 `?task=<id>` 锚点支持。
- 未来若引入移动端推送，从 `user_notification.severity='urgent'` 的 changefeed 派发；不在本 issue 实现。
