Status: needs-triage
Label: needs-triage

# VO-09 — 办公室 UI：花名册 + 消息流 + 任务看板（前端直连 SurrealDB）

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

工作区级别新增"办公室"页面，展示 **虚拟办公室** 当前状态。三块：

### 1. 花名册（左栏，两个 tab）

- **虚拟员工**：`db.live('user', q => q.where('kind', '=', 'virtual'))`；每条显示岗位 label、上级、`virtual_profile.last_active_at`。
  操作：暂停 / 恢复 / 退休 → 调后端 `POST /api/workspaces/:slug/employees/:id/pause|resume|retire`（dispatcher 需要同步关 LIVE + 清缓存，参见 virtual-office issue 03/04）。
- **真人成员**：`db.live('user', q => q.where('kind', '=', 'human'))`；显示 display_name / email / is_admin 徽章 / `last_seen_at`（NONE → "从未登录"）。
  操作（仅 admin 可见）：添加成员（输入 email + 是否管理员）→ 调 Workspace Scope Module `POST /api/workspaces/:slug/members`；移除成员 → `DELETE /api/workspaces/:slug/members/:userId`；切换 admin → `PATCH /api/workspaces/:slug/members/:userId`。前端不直接写 human `user` 行。

### 2. 活动流（中栏）

- `db.live('office_message')` + `db.live('office_report')`，按 created_at desc 合并渲染。
- 消息：from avatar + body。汇报：高亮卡片，显示 task、summary、next_steps、blocked_by。
- 滚动加载历史：`db.query('SELECT * FROM office_message ORDER BY created_at DESC LIMIT 50 START $offset', { offset })`。

### 3. 任务看板（右栏 / 第二 tab）

- `db.live('office_task')`，按 status 分列（open / in_progress / blocked / done / stalled）。
- 卡片：assigner → assignee、goal、due_at、最新更新。
- 重派 / 取消：admin 直接 `db.update(task, { status })`，PERMISSIONS 兜底。

### 路由 / 入口

- 在工作簿侧栏新增"办公室"入口（icon: building）
- URL：`/w/<slug>/office`（Web 路由）

### 渲染层

- Svelte 5 + `getSurreal()`（web-frontend-migration issue 03 提供）。
- 办公室业务数据读 / 写 / LIVE 直连 SurrealDB。
- 例外：真人成员管理走 Workspace Scope Module member endpoints，因为必须原子同写 workspace db `user` 与 `_system.user_workspace_index`；暂停 / 恢复 / 退休员工调后端 employee lifecycle endpoint，因为 dispatcher 需要同步清缓存 + 关闭对应 LIVE 会话。
- 切换 workspace 时旧 LIVE 订阅由组件 onDestroy 自动 kill；新连接由 `enterWorkspace` 重新建立。

## Acceptance criteria

- [ ] 创建一个 echo 员工后，花名册立即显示（浏览器 `db.live('user')` 触发），无需刷新。
- [ ] 心跳触发产生消息后，活动流 ≤1s 内出现新卡片（浏览器 `db.live('office_message')`）。
- [ ] admin 在看板点"重派" → `db.update(task, { status: 'open' })` 成功 → dispatcher 该员工的 LIVE 命中 → 重新拉起执行窗口。
- [ ] 普通成员尝试改别人 task 的 status → PERMISSIONS 拒绝，UI 提示。
- [ ] 非 admin 用户看不到"添加成员 / 暂停 / 退休"按钮；若绕过 UI 调 member / employee lifecycle endpoint，后端按 Workspace Scope Module 的目标 workspace 管理员校验返回 403。
- [ ] 切换 workspace 时所有 office 相关 LIVE 都被 kill；新 workspace 重新订阅。
- [ ] 花名册的"真人成员"tab 能区分"从未登录"（last_seen_at = NONE）与"上次于 XXX"。

## Blocked by

- `.scratch/virtual-office/issues/04-office-dispatcher-tracer.md`
- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`
- `.scratch/workspace-as-db/issues/07-member-management-endpoints.md`
- `.scratch/web-frontend-migration/issues/03-surrealdb-direct-client.md`

## Notes

- 本 issue 不实现真人 → 虚拟员工的发消息 UI；那是聊天功能立项的事。
- 活动流的"已读"状态本期不做，留给聊天功能立项。
- "添加成员"操作只调 Workspace Scope Module；该 Module 负责维护 workspace db `user`、`_system.user_workspace_index` 与必要的 IdP scope 侧效应。前端不要直连写 human `user` 行。
