Status: ready-for-agent
Label: ready-for-agent
Category: feature
Priority: P0

# WS-01 — 工作区设置页骨架 + 成员管理区块（邀请协作者）

## Parent

`.scratch/workspace-settings/PRD.md`

## What to build

新建**工作区级设置页**（与个人设置 ProfileScreen 分离），落地第一个区块：**成员管理**——它就是「邀请真正的协作者」的承载页。后端成员管理 endpoint 已完整就绪（`server/src/workspaces/member-manager.ts` + `server/src/routes/members.ts`，WP-C-07 done），本 issue 是**纯前端**：建页 + 花名册（直连读）+ 增/改角色/移除（调已就绪 endpoint）。

### 邀请模型（不要扩范围）

「直接开通」——管理员填 email + 角色即调 `POST /api/workspaces/:slug/members` 预创建成员，被邀请者首次登录回填 subject。**不做**邀请链接 / token / 接受流程 / 邮件。这是 CLAUDE.md「架构内无邀请闭环」既定决策。

### 数据路径

- **花名册读（浏览器直连）**：用 `getSurreal()` 读当前 ws db
  `SELECT id, display_name, email, is_admin, subject FROM user WHERE kind = 'human' AND disabled_at = NONE`。
  - `subject = NONE` → 展示「待加入」态（已预创建、尚未首次登录），区别于已激活成员。
  - **不**加后端花名册代理 endpoint（CLAUDE.md：不在后端加业务 CRUD 代理；读路径走直连）。
- **写路径（调已就绪后端 endpoint，经 `web/src/lib/api.ts` 的 Hono RPC client）**：
  - 添加：`POST /api/workspaces/:slug/members`，body `{ email, displayName?, isAdmin }`。
  - 改角色：`PATCH /api/workspaces/:slug/members/:userId`，body `{ isAdmin }`。
  - 移除：`DELETE /api/workspaces/:slug/members/:userId`（软移除）。
  - 写成功后**重新直连读**花名册刷新（不本地乐观拼装，避免与 _system 索引漂移）。
  - **前端不直接 INSERT/UPDATE/DELETE human `user`**——这些走后端 root 原子同写两边。
- record id（移除/改角色的 `:userId`）传参规则：从直连读到的 `id` 取 record id 的 **id 部分**字符串传给 endpoint path（endpoint 内部 `new RecordId("user", userId)`）；前端持有的 record 值遵循 `web/src/lib/record-id.ts` 边界规则。

### 路由 / 入口

- `/w/:slug/settings` 已被**个人设置**（ProfileScreen，PC-01）占用，**不要覆盖**。工作区设置用**新 page key**。
  - 建议 `admin`（route.ts 文档注释已预留 `admin` / `admin-console`），或新增 `workspace-settings`。在 issue 内定一个，更新 `route.ts` 的 `WORKSPACE_PAGES` 与 `WorkspacePage` 类型。
- 入口：侧栏（`SideNav.svelte`）加「工作区设置」入口，**仅管理员可见**——用 `permissions.ts` 的 `isWorkspaceAdmin(currentWorkspace.role)` 做入口可见性（纯 UI seam，非安全边界）。普通成员不显示入口或显示只读态。

### 落地形态（沿用仓库范式：纯逻辑层 + runes 镜像 + 组件）

- `web/src/lib/members-data.ts`：纯逻辑层，可单测。
  - `loadMembers(conn, ...)`：直连 SELECT，归一成 `{ id, displayName, email, isAdmin, pending }[]`（`pending = subject 为空`）。
  - `addMember` / `updateMemberRole` / `removeMember`：调 api client，归一返回 `{ ok, message? }`。
- `web/src/screens/WorkspaceSettingsScreen.svelte`（或同义名）：UI，含成员区块。本 issue 只放成员区块，基本信息区块留 WS-03。
- 接进 `WorkspaceScreen.svelte` 的对应 page 分支 + `SideNav.svelte` 入口。

## Edge cases

- 管理员把**自己**降级 / 移除自己：前端给二次确认提示。「最后一个管理员不可降级」是否后端兜，记为本 issue 决策点（V1 可仅前端提示，不强约束）。
- email 已存在（已是成员）：后端 `ON DUPLICATE KEY UPDATE` 兜，前端把 200 当成功并刷新即可。
- 非管理员绕过入口直接访问该 page key：写操作后端 403（access 真相源），前端展示错误态，不崩。
- 花名册为空（仅自己）：正常渲染当前管理员一行。

## Acceptance criteria

- [ ] 管理员从侧栏专属入口进入工作区设置页（新 page key，未覆盖 `/w/:slug/settings` 个人设置）；普通成员看不到该入口。
- [ ] 花名册浏览器直连读 `user`（`kind='human' AND disabled_at = NONE`），展示 display_name / email / 角色；`subject` 空的成员显示「待加入」态。
- [ ] 添加 email + 角色 → 调 `POST .../members` → 成功后重新直连读，花名册出现新「待加入」成员。
- [ ] 改角色调 `PATCH .../members/:userId`、移除调 `DELETE .../members/:userId`，均生效且花名册刷新。
- [ ] 写路径全部走后端 endpoint，前端无对 human `user` 的直连 INSERT/UPDATE/DELETE。
- [ ] 入口可见性走 `permissions.ts` seam；非管理员写操作后端 403 时前端有错误态、不崩。
- [ ] `members-data.ts` 有单测覆盖 load（含 pending 派生）与三个写动作（成功 / 失败归一）。
- [ ] `pnpm --filter @surreal-ck/web test` / `typecheck` / `build` 通过；无 legacy `appApi` / desktop import。

## 显式不做

- 邀请链接 / token / 接受流程 / pending 状态机（「直接开通」不需要）
- 邮件发送
- 工作区基本信息区块（WS-02/03）
- 删除 / 归档 workspace、默认权限 / 偏好、改 slug
- 改动 `ShareModal`（工作簿级分享，本簇不碰）

## Blocked by

None — 后端成员管理 endpoint 已 done，可立即开工。
