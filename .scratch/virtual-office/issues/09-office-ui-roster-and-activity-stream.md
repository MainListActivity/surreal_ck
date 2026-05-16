Status: needs-triage
Label: needs-triage

# VO-09 — 办公室 UI：花名册 + 消息流 + 任务看板

## Parent

`.scratch/virtual-office/PRD.md`

## What to build

工作区级别新增"办公室"页面，展示 **虚拟办公室** 当前状态。三块：

### 1. 花名册（左栏）

- 列出本 workspace 所有 `app_user.kind='virtual'`
- 每个员工显示：岗位 label、上级、最近一次 `virtual_profile.last_active_at`
- 操作：暂停 / 恢复 / 退休（调用 issue 03 的 RPC）

### 2. 活动流（中栏）

- LIVE SELECT `office_message + office_report`，按 created_at desc
- 渲染样式：
  - 消息：from avatar + body
  - 汇报：高亮卡片，显示 task、summary、next_steps、blocked_by
- 滚动加载历史

### 3. 任务看板（右栏 / 第二 tab）

- 按 `office_task.status` 分列：`open / in_progress / blocked / done / stalled`
- 卡片：assigner → assignee、goal、due_at、最新更新
- owner 可点击 stalled 任务"重派"或"取消"

### 路由 / 入口

- 在工作簿侧栏新增"办公室"入口（icon: building）
- URL：`/workspace/<slug>/office`（Web 路由）

### 渲染层

- Svelte 5 前端**不直连 SurrealDB**（自部署在内网，不公网暴露）。所有读 / LIVE 走后端 WS 端点：
  - `GET /api/workspaces/:slug/office/state`：一次性拉花名册 / 最新消息 / 任务看板
  - `WS /api/workspaces/:slug/office/stream`：后端在该 workspace db 用调用者 JWT SIGNIN 后建 LIVE SELECT，事件透传给浏览器
- 写操作（"重派"、"取消"、"暂停员工"、"退休员工"）走后端 HTTP endpoint：
  - `POST /api/workspaces/:slug/office/tasks/:id/restate`（body: `{ status }`）
  - `POST /api/workspaces/:slug/employees/:id/pause` / `/resume` / `/retire`
- 后端 endpoint 内部按调用者身份调相应 access SIGNIN（先 `admin` 失败再 `participant`），再透传写入。"暂停 / 退休"endpoint 仅 admin 能成功：admin SIGNIN 通过后写 `user.virtual_profile.status`；participant SIGNIN 通过的会话 PERMISSIONS 拒绝。

### 后端 `POST /api/sessions`（统一登录 / 选 access）

issue 09 同时提供这个共享 endpoint（issue 03 / 10 / 11 都复用）：

入参：`{ workspaceSlug, oidcToken }`。流程：

1. OIDC verify token。
2. 查 `_system.workspace` 拿到 `db_name`。
3. 先尝试 `SIGNIN { ac: 'admin', ns: 'main', db: <db_name>, token: <oidcToken> }`：
   - 成功：返回 `{ access: 'admin', token: <surreal-jwt-1h> }`，缓存在 session。
4. 否则尝试 `SIGNIN { ac: 'participant', ns: 'main', db: <db_name>, subject: $token.sub }`：
   - 成功：返回 `{ access: 'participant', token: <surreal-jwt-1h> }`。
5. 都失败：401。

## Acceptance criteria

- [ ] 创建一个 echo 员工后，花名册立即显示（后端 WS 转发 user 表 LIVE），无需刷新
- [ ] 心跳触发产生消息后，活动流 ≤1s 内出现新卡片（后端 WS 转发 office_message LIVE）
- [ ] admin 点"重派"调后端 endpoint → task 改成 open → dispatcher（该员工 LIVE 命中）再次拉起
- [ ] 非 admin 用户（participant access 通道）调"暂停 / 退休"endpoint 返回 403（admin SIGNIN AUTHENTICATE 失败 → 后端拒绝）；前端按 `/api/sessions` 返回的 `access` 字段隐藏按钮
- [ ] 切换 workspace 时后端 WS 端点关闭对应 LIVE 订阅（防连接泄漏）
- [ ] `/api/sessions` 对管理员返回 `{ access: 'admin' }`，对普通成员返回 `{ access: 'participant' }`，对非该 workspace 用户返回 401

## Blocked by

- `.scratch/virtual-office/issues/04-office-dispatcher-tracer.md`
- `.scratch/virtual-office/issues/06-project-manager-role-bundle.md`

## Notes

- 本 issue 不实现真人 → 虚拟员工的发消息 UI；那是聊天功能立项的事。
- 活动流的"已读"状态本期不做，留给聊天功能立项。
