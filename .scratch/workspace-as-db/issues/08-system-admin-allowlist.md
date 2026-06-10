Status: done
Label: enhancement
Category: enhancement

# WP-C-08 — system_admin 创建能力开关 + 登录 hook 签发建库能力位

## Parent

`.scratch/workspace-as-db/PRD.md`

## 背景

WP-C-06 第 2 步（`06-workspace-create-lifecycle.md:33`）把"用户是否有创建 workspace 权限"留成了 MVP 占位：

> "校验用户是否有创建 workspace 权限（MVP 可先用配置 allowlist 或 token claim，后续接计费/entitlement）。"

实现时 `server/src/routes/workspaces.ts` 的创建权限曾走 **token claim** 这条路（认 `can_create_workspace===true` / `workspace:create` scope）。现在口径已调整为：`_system.system_admin` 表内只要有任意一行，就允许当前登录用户创建 workspace。若路由层仍按旧 token claim 校验，会在 `POST /api/workspaces` 上误报 `Workspace creation is not allowed for this user`。

IdP（`ma_hono` 仓）此前的 custom claim 只支持 `fixed` / `user_field` 两种源，无法从外部 hook 取值，所以既不会签发 surreal db/ac scope，也不会签发 `can_create_workspace`。本 issue 与 ma_hono 的「hook claim 源」改动配套落地。

## What to build

采用 **部署级开关** 这一支：`_system.system_admin` 仍保留 subject/email/note 作为 seed 与审计入口，但创建权限判定不再要求当前 subject 命中该表；只要表内存在任意一行，登录 hook 和后端创建 endpoint 都视为建库能力开启。

### 1. `_system` schema：创建能力开关表

- `shared/sql/system/` 增量 `.surql`（紧接现有 `001-init` / `002-member-index-subject-optional` 版本号往后排），新增 `system_admin` 表。
- 主键/唯一索引按 **subject**（OIDC sub），root-only，无 access（与现有 `_system` 表一致，PRD:30）。subject 用于 seed / 审计，不再作为创建 workspace 的逐用户授权条件。
- 字段：`subject`（唯一）、`email?`、`added_at`、`note?`。

### 2. 启动 seed：从 env 注入初始名单

- `server/src/db/`（system-schema 初始化路径）启动时读 env `SYSTEM_ADMIN_SUBJECTS`（逗号分隔 subject），对每个 `ON DUPLICATE KEY UPDATE` upsert 进 `system_admin`。
- env 留空则不注入；表为空时创建 workspace 能力关闭。只要 seed 或手工 SurrealQL 写入任意一行，创建能力对登录用户开启。

### 3. 登录 hook 返回扩展

- `server/src/workspaces/workspace-scope.ts` `getDefaultScope`：
  - 查 `system_admin` 是否存在任意行 → `canCreateWorkspace`。
  - 返回结构扩展为携带 `canCreateWorkspace`。
  - **默认 db 选择**：若调用者无任何 workspace 且 `system_admin` 非空，返回 `db=_system, ac=admin`（登录到 _system 后即可 POST /api/workspaces），避免被 `login-denied` 卡死；已有 workspace 则照常返回最近选择的 ws，`canCreateWorkspace` 仍为 true。
- `server/src/routes/internal-idp.ts`：`/api/internal/idp/default-scope` 返回**扁平对象**（不再只 `c.json(result.scope)`），字段名与 ma_hono 各 hook-claim 的 hookField 约定一致：`db` / `ac` / `can_create_workspace`。
- 鉴权复用现有 `requireInternalHook`（`server/src/middleware/internal-hook-auth.ts`），secret 与 ma_hono `CLAIM_HOOK_SECRET` 对齐。

### 4. 判定口径对齐

- `/api/session/workspaces` 返回的 `canCreate` 来自 `system_admin` 是否非空；前端只消费该后端 capability，不自行解 token 判定。
- `POST /api/workspaces` 必须调用 Workspace Scope Module 获取 `canCreate`，不得只信任 `can_create_workspace` token claim 或 `workspace:create` scope。
- hook 把 `can_create_workspace:true` 写进 token claim 后，可用于 IdP / UI 观察，但安全闸门仍在后端 `POST /api/workspaces`。
- hookField 约定的 claim 名固定为 `can_create_workspace`（与现有判定一致）。

## Acceptance criteria

- [ ] `_system.system_admin` 表存在，按 subject 唯一；重复启动幂等。
- [ ] `SYSTEM_ADMIN_SUBJECTS` 注入的 subject 出现在 `system_admin`。
- [ ] `getDefaultScope`：`system_admin` 非空时，任意 subject → `canCreateWorkspace=true`；无 ws 时返回 `_system` admin scope。
- [ ] `system_admin` 为空时，有 ws 返回最近 ws 且 `canCreateWorkspace=false`；无 ws 仍 `login-denied`。
- [ ] `/api/internal/idp/default-scope` 返回扁平对象含 `can_create_workspace`。
- [ ] `system_admin` 非空时，`POST /api/workspaces` 即使 token 没有 `can_create_workspace` / `workspace:create` 也能建库，不被 403。
- [ ] `system_admin` 为空时，`POST /api/workspaces` 返回 403 `workspace-create-forbidden`，不调用 provisioning。

## 不在本轮范围（另拆 issue）

- 后台「管理创建能力开关 / system_admin 行」表单 UI —— 本轮只打通能力位，零 UI（靠 env + 手工 SurrealQL）。
- 成员邀请闭环（见 WP-C-07）。
- entitlement / 计费。

## Blocked by

- `.scratch/workspace-as-db/issues/06-workspace-create-lifecycle.md`（done）
- ma_hono：hook claim 源（配套，另一仓）

## Notes

- 跨仓配套：ma_hono 给 surreal-ck 的 web client 配三条 hook claim：
  `https://surrealdb.com/db`←`db`、`https://surrealdb.com/ac`←`ac`、`can_create_workspace`←`can_create_workspace`。
- ma_hono env：`CLAIM_HOOK_URL`（指向本 hook）+ `CLAIM_HOOK_SECRET`。
- surreal_ck env：`SYSTEM_ADMIN_SUBJECTS` + `IDP_HOOK_SECRET`（与 ma_hono 对齐）。
