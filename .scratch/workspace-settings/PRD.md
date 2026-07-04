# 工作区设置 + 邀请协作者 PRD

创建时间：2026-06-27

依据：
- [`docs/adr/frontend-direct-connect.md`](../../docs/adr/frontend-direct-connect.md)
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)
- `.scratch/workspace-as-db/PRD.md`（成员管理后端 WP-C-07 已 done）
- `.scratch/profile-center/issues/01-identity-card.md`（个人设置 = ProfileScreen，已 done，占用 `/w/:slug/settings`）

## 一句话

新建**工作区级设置页**（与「个人设置」分离），V1 含两个区块：**成员管理**（= 邀请真正的协作者）和**工作区基本信息**（改显示名）。成员管理后端 endpoint 已完整就绪（`member-manager.ts`），本簇主要是补前端承载页；基本信息区块需补一个窄后端 endpoint `PATCH /api/workspaces/:slug`。

## 背景与现状盘点

| 能力 | 后端 | 前端 |
|---|---|---|
| 成员增 / 改角色 / 软移除 | ✅ 已 done（`POST/PATCH/DELETE /api/workspaces/:slug/members*`，root 原子同写 ws db `user` + `_system.user_workspace_index`） | ❌ 无任何 UI；`ShareModal` 是纯前端假链接 stub |
| 工作区改名 | ❌ 无 endpoint（`workspace` 元数据在 `_system` db，前端不能跨 db 改） | ❌ 无 |
| 个人设置（身份卡） | n/a（前端直连） | ✅ 已 done（ProfileScreen，page key = `settings`） |

## 邀请模型（经决策确定 = 「直接开通」）

沿用现有架构，**不引入邀请闭环 / 邀请 token / 邮件服务**：

- 工作区管理员在设置页填 **email + 角色**，调 `POST /api/workspaces/:slug/members` 即开通。
- 后端预创建 human `user`（subject = NONE），被邀请者**首次 OIDC 登录**时由 access AUTHENTICATE / switch-workspace 按 email 回填 subject。
- 这是 CLAUDE.md / `frontend-direct-connect.md` 既定的「架构内无邀请闭环」决策，本簇**不违背**。

## 范围（V1）

### 做

1. **工作区设置页骨架**：新路由 + page key（区别于个人设置 `settings`），管理员可见入口。
2. **成员管理区块**：
   - 花名册：浏览器**直连**读当前 ws db `user`（`kind='human' AND disabled_at = NONE`），展示 display_name / email / 角色。
   - 添加成员：表单填 email + isAdmin，调 `POST /api/workspaces/:slug/members`，成功后刷新花名册。
   - 改角色：调 `PATCH .../members/:userId`。
   - 移除成员：调 `DELETE .../members/:userId`（软移除）。
3. **工作区基本信息区块**：
   - 后端新增 `PATCH /api/workspaces/:slug`（root 改 `_system.workspace.name`，管理员校验同 member-manager 口径）。
   - 前端改显示名表单。
4. **导航收尾**：侧栏 / 入口区分「个人设置」vs「工作区设置」，工作区设置仅管理员可见入口。

### 不做（V1 范围外）

- ❌ 邀请链接 / 邀请 token / 接受流程 / pending 状态机（「直接开通」模式不需要）
- ❌ 邮件发送服务
- ❌ 删除 / 归档 workspace（危险区，V2）
- ❌ 默认权限 / 工作区级偏好（新成员默认角色、默认视图权限等，V2）
- ❌ 改 slug（slug 是 db_name / URL 锚点，改动影响面大，V2）
- ❌ 重写 / 删除 `ShareModal`（工作簿级分享，本簇不碰）

## 关键约束

- 花名册**读路径**走浏览器直连（`getSurreal()`），不加后端代理 endpoint（CLAUDE.md：不在后端加业务 CRUD 代理）。
- 成员**写路径**走已就绪后端 endpoint（成员管理是 scope/lifecycle 维护，不是普通业务 CRUD；前端不直接 INSERT/UPDATE/DELETE human `user`）。
- 工作区改名走后端 `PATCH`（`_system.workspace` 在 root-only db，浏览器无权跨 db 写）。
- 不在前端写 `if (!is_admin) throw 403` 做硬守卫；admin 校验真相源在后端 + DB access 类型。前端权限只用于**入口可见性**（沿用 `permissions.ts` role seam）。
- record id 传 SDK 一律用 `RecordId` / `StringRecordId` 包裹（见 `web/src/lib/record-id.ts`）。
- 后端写 SurrealQL 前先走 `surrealql` skill。

## 风险

- **改角色把自己降级**：管理员把唯一管理员降成普通成员会失去管理能力。V1 至少前端给确认/提示；是否后端兜「最后一个管理员不可降级」记为 issue 内决策点。
- **email 回填漂移**：预创建成员未登录前 `subject = NONE`，花名册需正确展示「待加入」态（区别于已激活成员）。
- **路由冲突**：`/w/:slug/settings` 已被个人设置占用，工作区设置必须用新 page key，避免覆盖 PC-01。

## Issue 路线图

| # | 名称 | 主体 | 优先级 | 依赖 |
|---|---|---|---|---|
| 01 | 工作区设置页骨架 + 成员管理区块（邀请协作者）| 新路由 + page key + 入口 + 花名册（直连读）+ 增/改角色/移除（调已就绪 endpoint）| **P0** | 无（后端已 done）|
| 02 | 工作区基本信息后端 endpoint | `PATCH /api/workspaces/:slug` 改 `_system.workspace.name`（root + admin 校验 + 装配 + 测试）| **P1** | 无 |
| 03 | 工作区基本信息区块前端 | 设置页加「基本信息」区块，改显示名表单，调 02 endpoint | **P1** | 01, 02 |

## 验收 KPI

- 管理员能从专属入口进入工作区设置页，普通成员看不到该入口（或看到只读态）。
- 添加 email + 角色 → 后端预创建成功 → 花名册出现「待加入」成员；改角色 / 移除生效且花名册刷新。
- 改工作区显示名 → 后端 `_system.workspace.name` 更新 → 侧栏 / 标题随之刷新。
- `pnpm --filter @surreal-ck/web test` / `typecheck` / `build` 通过；后端新增 endpoint 有单测。
