Status: done
Label: ready-for-agent

# PC-01 — 个人中心身份卡（直连读写 + 侧栏同步）

## What to build

把 `/w/:slug/settings` 当前的「个人设置待迁移」占位换成一张**可用的身份信息卡**，完成一条端到端路径：进页直连当前 workspace db 读取当前用户 → 编辑 `display_name` → 保存写回 db → 侧栏用户名/头像同步刷新。

本特性经 grill-me 收口，核心定位与约束如下（不要扩范围）：

- **纯个人账户页**，作用域 = 当前 workspace；个人数据落当前 workspace db 的 `user` 表，**不做跨 workspace**。
- **V1 只做身份信息卡，零 schema 变动**——`user` 表已有 `display_name` / `avatar`，不新增字段、不动权限表达式。
- 卡内字段：
  - `display_name`：**唯一可写**，允许为空。
  - `avatar`：只读，复用现有字母头像（按名生成），**不做上传、不暴露编辑**。
  - `email`、角色（管理员/成员，来自 `is_admin`）：只读。

### 数据路径（关键约束）

- **定位当前用户行统一用 `fn::current_user()`**（`009-fn-current-user.surql` 已落地）。管理员（admin access = TYPE JWT，`$auth = NONE`，走 `$token.sub` → `user.subject`）和普通成员（participant = TYPE RECORD，走 `$auth.id`）走同一条路径，业务代码**不要**依赖 `$auth` 来定位「我是哪一行」。
- **读**：进页时直连 `SELECT * FROM ONLY user WHERE id = fn::current_user()`，db 为 single source of truth（不要用登录 claim 快照里的 name 当真值）。
- **写**：`UPDATE $userId SET display_name = $name`。`$userId` 用 `new StringRecordId(...)`（或 `RecordId`）包裹再传 SDK `update()`；遵循仓库规则——明确 update 的 record id，不直接写裸 `query`。
- **空名处理**：`display_name` 清空时写 `undefined` / 省略该字段，**不要写 JS `null`**（`option<T>` 引擎拒 null，用 `shared/src/surreal-values.ts` 的 helper）。
- **不动 `user` 表 PERMISSIONS**：admin JWT 数据库级绕过表 PERMISSIONS，participant 走 `id = $auth`，两类身份都能改自己那行，无需改 update 条件。

### 侧栏同步

侧栏 `userName` 来自 `getCurrentUser()` store，而该 store 的 `CurrentUser` 当前只有 `subject/email/name`、且只在 `enterWorkspace` 时填一次（来自登录 claim 快照），**不含 `display_name` 也不随 db 更新**。本 slice 需：

- 微扩 `CurrentUser` 类型加 `displayName`，并在 `workspace-store` 暴露一个 setter（如 `setCurrentUserDisplayName`），runes 镜像层同步发布。
- 身份卡 `UPDATE` 成功后回写该 setter，侧栏 `$derived` 自动刷新（无需重新登录/重进 workspace）。

### 落地形态（沿用仓库「纯逻辑层 + runes 镜像 + 组件」范式）

- `web/src/lib/profile-data.ts`：纯逻辑层，`loadCurrentUser()` / `saveDisplayName()` 直连 `SurrealConn`，可单测（不进 Svelte runes）。
- `web/src/screens/ProfileScreen.svelte`：UI，替掉 `WorkspaceScreen.svelte` 中 `page === "settings"` 分支的 `PlaceholderScreen`。
- `web/src/lib/workspace-store.ts` + `workspace-store.svelte.ts`：上面的 `CurrentUser` 扩展 + setter。
- **route 不改**：`page key` 仍是 `settings`，`route.ts` / 侧栏「个人设置」文案保持不动。

### Edge cases

- `fn::current_user()` 返回 NONE（root 维护连接 / 异常）→ 身份卡显示「无法定位当前用户」错误态，禁用编辑。
- `display_name` 为空 → 侧栏 / 头像回退用 email 首字母。
- 虚拟员工（`kind = 'virtual'`）不进此页（无浏览器会话），无需为其处理。

## Acceptance criteria

- [ ] 访问 `/w/:slug/settings` 渲染 `ProfileScreen`（身份卡），不再是 PlaceholderScreen 占位。
- [ ] 身份卡进页时直连读取 `SELECT * FROM ONLY user WHERE id = fn::current_user()`，展示真实的 `display_name`、`email`、角色（管理员/成员）。
- [ ] `display_name` 可编辑并保存；保存走 `UPDATE $userId SET display_name = $name`，record id 用 RecordId 类型包裹，空名写 `undefined`（不写 JS null）。
- [ ] 同一路径对**管理员**（admin JWT）和**普通成员**（participant）都能正确定位并保存自己那行——不依赖 `$auth` 定位。
- [ ] 保存成功后回写 `CurrentUser` store，左下角侧栏的用户名/字母头像随之刷新，无需重新登录。
- [ ] `avatar` / `email` / 角色为只读展示；avatar 为字母头像，无上传入口。
- [ ] `fn::current_user()` 解析失败时显示「无法定位当前用户」错误态并禁用编辑。
- [ ] `profile-data.ts` 纯逻辑层有单测覆盖 load / save（含空名 → undefined）；route.ts page key 仍为 `settings`，未改动路由。
- [ ] `pnpm --filter @surreal-ck/web test`、`typecheck`、`build` 通过；浏览器 console 无 legacy `appApi` / desktop shell import。

## 显式不做（V1 范围外）

- 跨 workspace 用户/偏好列表
- `user.preferences` 字段及界面偏好（主题 / 语言 / 默认视图）
- avatar 图片上传 / URL 自定义
- 安全 / 会话区块（设备、退出所有会话等）
- AI / embedding key 配置（新架构由后端 env 统一管，前端不持有）

## Blocked by

None - can start immediately

## Resolution

新增 / 接线：

- `web/src/lib/profile-data.ts`：纯逻辑数据层。`loadCurrentUser()` 直连 `SELECT * FROM user WHERE id = fn::current_user() LIMIT 1` 取 `rows[0]`（**不用 `FROM ONLY`**——`conn.query` 取首语句结果集并按数组对待，`ONLY` 返单对象会破坏该契约）；`saveDisplayName()` 走 `UPDATE $id SET display_name = $name`，id 用 `toRecordId()` 包成 StringRecordId，空名经 `mapNullToSurrealNone` 写 `undefined`(NONE) 不写 null，写入异常归一成 `{ ok:false, message }`。
- `web/src/screens/ProfileScreen.svelte`：身份卡 UI。连接 open 后 `$effect` 触发 load；`display_name` 可编辑（dirty 才可保存），email / 角色只读，字母头像随草稿名实时变；保存成功回写 store + 「已保存」flash；`fn::current_user()` 解析不到 → EmptyState「无法定位当前用户」并禁用编辑。
- `web/src/screens/WorkspaceScreen.svelte`：`page === "settings"` 分支由 PlaceholderScreen 换成 `<ProfileScreen />`。route page key 仍 `settings`，未动 `route.ts`。
- `web/src/lib/workspace-store.ts` + `.svelte.ts`：`CurrentUser` 加 `displayName?: string | null`，state 加 `setCurrentUserDisplayName`，runes 镜像导出同名函数。
- `web/src/components/SideNav.svelte`：`userName` 派生改为 `displayName || name || email || "我"`，保存后 `$derived` 自动刷新侧栏名 + 头像。

验证：

- `web/src/lib/profile-data.test.ts`：7 个用例覆盖 load（record id 字符串化 / 缺省字段 / 空结果 → null）与 save（UPDATE $id + StringRecordId + trim 非空 / 空名 → undefined / 异常 → ok:false）。
- 两条语句经 `surreal validate`（CLI 3.0.5）通过；`fn::current_user()` 可用于 WHERE，`UPDATE $id`（绑定 record id 参数）为正确形式。
- `pnpm --filter @surreal-ck/web test`（360 pass）、`typecheck`（0 errors）、`build` 均通过。

V1 范围外（未做）：跨 workspace、`user.preferences` 字段及界面偏好、avatar 上传、安全/会话区块、AI/embedding key 配置。
