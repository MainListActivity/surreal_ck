Status: ready-for-agent
Label: ready-for-agent

# SHADCN-02 — Dialog 群 + WorkspaceSwitcher 迁移

## Parent

`.scratch/shadcn-migration/PRD.md`

## What to build

把 4 个手搓 modal/dialog 与 WorkspaceSwitcher 迁到 shadcn-svelte 封装：

- `CreateWorkspaceDialog` / `AddRecordModal` / `ShareModal` → shadcn **Dialog**
- `LeaveDraftModal`（离开确认）→ shadcn **AlertDialog**
- `WorkspaceSwitcher` → shadcn **DropdownMenu**

走封装路线：`pnpm dlx shadcn-svelte@latest add dialog alert-dialog dropdown-menu`，官方默认样式（视觉对齐留 SHADCN-04）。

核心收益：4 个 modal 现在各自手搓 `.modal-backdrop` / `.backdrop`，**没有焦点陷阱、没有 Escape 关闭**。bits-ui Dialog 免费送焦点陷阱 / Escape / scroll-lock / aria 绑定。

⚠️ **两种可见性模式并存，迁移方式不同**：
- `CreateWorkspaceDialog` 由父组件用 `{#if}` + `onclose` 回调控制可见性（NoWorkspaceScreen、WorkspaceSwitcher 两处调用）。
- `AddRecordModal` / `ShareModal` / `LeaveDraftModal` 在 EditorScreen 里**无条件挂载**，可见性由内部读 `editorStore` 状态自控——迁移时要从"读 store 决定是否渲染"改成"读 store 绑到 bits-ui Dialog 的 `bind:open`"。

## Acceptance criteria

- [ ] `$lib/components/ui/dialog/`、`ui/alert-dialog/`、`ui/dropdown-menu/` 经 CLI add 生成
- [ ] 4 个 dialog 改用新封装；焦点陷阱 / Escape / scroll-lock / 外点关闭由 bits-ui 接管，删除手搓 backdrop
- [ ] store-driven 三个 modal 的可见性正确接到 `bind:open`，开关行为与现状等价
- [ ] WorkspaceSwitcher 改用 DropdownMenu，切换 / 新建入口 / 外点关闭行为等价
- [ ] 全仓无残留手搓 `.modal-backdrop` / `handleDocumentPointer`（针对这些组件）
- [ ] `pnpm --filter @surreal-ck/web run typecheck` 通过
- [ ] `pnpm --filter @surreal-ck/web run test` 通过

## Blocked by

- `.scratch/shadcn-migration/issues/01-select-shadcn.md`（验证封装路线后套路复制）
