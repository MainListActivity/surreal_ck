Status: ready-for-agent
Label: ready-for-agent
Category: feature
Priority: P1

# WS-03 — 工作区基本信息区块（前端，改显示名）

## Parent

`.scratch/workspace-settings/PRD.md`

## What to build

在 WS-01 建好的工作区设置页里加第二个区块：**基本信息**——改 workspace 显示名，调 WS-02 的 `PATCH /api/workspaces/:slug`。

### 数据路径

- **读**：当前显示名从 `workspace-store` 的 `currentWorkspace`（已有 slug / name / role）取；slug / 角色只读展示。
- **写**：调 `PATCH /api/workspaces/:slug` body `{ name }`（经 `api.ts` Hono RPC client）。
  - 成功后回写 `workspace-store`（加 setter 如 `setCurrentWorkspaceName`，runes 镜像同步），让侧栏 / 标题 `$derived` 自动刷新——参照 PC-01 改 display_name 后侧栏同步的做法。
- 入口可见性 / 可写态走 `permissions.ts` `isWorkspaceAdmin`；普通成员只读展示（写按钮灰或区块只读）。

### 落地形态

- `web/src/lib/workspace-meta-data.ts`（或并入 WS-01 的 data 层）：`renameWorkspace(slug, name)` 调 api client，归一 `{ ok, message? }`，可单测。
- 在 `WorkspaceSettingsScreen.svelte` 加「基本信息」区块（dirty 才可保存、保存成功 flash，沿用 ProfileScreen 范式）。
- `workspace-store.ts` + `.svelte.ts`：`currentWorkspace.name` setter + runes 镜像导出。

## Edge cases

- 空名 / 仅空白 → 前端禁用保存（后端也兜 400）。
- 非管理员 → 区块只读，无保存入口；若仍触发，后端 403 → 错误态。
- 保存失败（网络 / 403 / 404）→ 不回写 store，展示错误。

## Acceptance criteria

- [ ] 工作区设置页有「基本信息」区块，展示当前 name（可改）、slug（只读）、当前用户角色（只读）。
- [ ] 改 name 保存 → 调 `PATCH /api/workspaces/:slug` → 成功后回写 `workspace-store`，侧栏 / 标题随之刷新，无需重进 workspace。
- [ ] 普通成员看到只读区块，无保存入口。
- [ ] 空名禁用保存；保存失败有错误态且不回写 store。
- [ ] data 层有单测覆盖 rename 成功 / 失败归一。
- [ ] `pnpm --filter @surreal-ck/web test` / `typecheck` / `build` 通过。

## 显式不做

- 改 slug（V2）
- 删除 / 归档 workspace、默认权限 / 偏好（V2）

## Blocked by

- `.scratch/workspace-settings/issues/01-settings-screen-and-members.md`（页骨架）
- `.scratch/workspace-settings/issues/02-workspace-rename-endpoint.md`（后端 endpoint）
