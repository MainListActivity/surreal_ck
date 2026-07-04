Status: ready-for-agent
Label: ready-for-agent
Category: feature
Priority: P1

# WS-02 — 工作区改名后端 endpoint（PATCH /api/workspaces/:slug）

## Parent

`.scratch/workspace-settings/PRD.md`

## What to build

补一个窄后端 endpoint，让工作区管理员改 workspace **显示名**。`workspace` 元数据在 `_system` db（root-only，无 access），浏览器不能跨 db 写，所以必须走后端 root。这是 workspace lifecycle / scope 维护路径，**不是**业务 CRUD 代理。

### Endpoint

- `PATCH /api/workspaces/:slug`，body `{ name: string }`。
  - `requireOidc()` 取调用者 subject。
  - admin 校验**口径同 member-manager**：root 读目标 ws db `user.is_admin`（DDL 权限真相源，`callerIsAdmin`），非管理员 → 403 `workspace-rename-forbidden`。
  - root 改 `_system.workspace SET name = $name WHERE slug = $slug`（`updated_at` 由 schema `VALUE time::now()` 自动刷新，不手写）。
  - workspace 不存在 / 非 active → 404。
  - `name` 校验：trim 后非空、长度上限（如 ≤ 80）；空 → 400 `workspace-name-invalid`。

### 落地形态

- 复用 `member-manager.ts` 的 root session 工厂与 `resolveWorkspace` / `callerIsAdmin` 模式——抽一个 `workspace-settings-manager.ts`（或在现有 manager 里加方法），保持 root 同写口径一致。
- 路由放 `server/src/routes/workspaces.ts`（已有 `POST /api/workspaces`）或单独 `workspace-meta.ts`；装配进 `createApp`，确保链式 `.route()` 推导出端到端类型（见 D2-05/06 踩过的 AppType 丢 schema 坑）。
- 写 SurrealQL 前走 `surrealql` skill。

## Rules

- 不在 endpoint 里手写 DDL 守卫之外的业务逻辑；只改 `name`，不碰 `slug` / `db_name` / `status`（改 slug 是 V2，且影响 db_name / URL）。
- 失败路径不记录 OIDC token / IdP token / SurrealDB root credential（同 WP-C-07 redaction 约定）。
- 不引入前端直连改 `_system`。

## Acceptance criteria

- [ ] 管理员 `PATCH /api/workspaces/:slug` body `{ name }` → `_system.workspace.name` 更新、`updated_at` 自动刷新，返回 `{ ok: true }`。
- [ ] 普通成员 / 非目标 workspace 成员调用 → 403，不写入。
- [ ] workspace 不存在 / 非 active → 404；空 name → 400。
- [ ] 端到端类型经 `createApp` 链推导（前端 `api.ts` 能拿到该 route 的类型）。
- [ ] 有单测覆盖：成功改名 / 403 / 404 / 空 name；失败路径无敏感凭证泄漏。
- [ ] `pnpm --filter @surreal-ck/server test` / `typecheck` 通过。

## 显式不做

- 改 slug / db_name / status（V2）
- 删除 / 归档 workspace（V2）
- 前端 UI（WS-03）

## Blocked by

None — 可与 WS-01 并行。
