Status: needs-triage
Label: needs-triage

# WP-D2-05a — Workspace 下拉菜单的新建入口

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

在 workspace 下拉选择器中补齐“新建 workspace”的用户路径：用户打开 workspace dropdown，点击“新建工作区”，进入 D2-06 的创建对话框；创建成功后关闭对话框、刷新 workspace 列表、silent refresh 后连接到新 workspace，并让 URL 落到 `/w/:slug`。

这张 issue 是 D2-05（切换器）和 D2-06（创建流程）之间的集成验收票。D2-05 已要求“有创建权限的用户看到按钮”，D2-06 已实现创建流程；本票专门保证用户从下拉菜单触发创建时不会断链。

## Acceptance criteria

- [ ] 有创建权限的用户打开 workspace dropdown 时能看到“新建工作区”入口；无创建权限用户看不到该入口。
- [ ] 点击“新建工作区”后 dropdown 关闭，并打开创建 workspace 对话框，当前列表和连接状态不被破坏。
- [ ] 创建成功后对话框关闭，前端 silent refresh，SurrealDB 重新 signin 到新 workspace，URL 更新为 `/w/:slug`。
- [ ] 创建成功后再次打开 workspace dropdown，新 workspace 出现在列表中且被标记为当前 workspace。
- [ ] `slug` 冲突、scope update 失败、refresh 失败时，错误显示在创建对话框内；dropdown 不丢失旧 workspace 状态。
- [ ] 用户取消创建时，只关闭对话框，不切换 workspace，不刷新 token，不清空列表。
- [ ] 这个入口不绕过 D2-06 的 `POST /api/workspaces` 流程；浏览器仍不持有 root / NS-admin / service token。
- [ ] 有单测或组件级测试覆盖：有权限显示入口、无权限隐藏入口、点击入口触发创建对话框、创建成功后 reload workspace list。

## Blocked by

- `.scratch/web-frontend-migration/issues/05-workspace-switcher.md`
- `.scratch/web-frontend-migration/issues/06-create-workspace-flow.md`

## Notes

- 现有 `WorkspaceSwitcher` 已有 `oncreate` seam；实现时应把它作为公共接口稳定下来，而不是让切换器直接 import 创建对话框。
- 07i 的 workspace 首页 shell 需要复用同一入口，避免首页顶栏和 workspace 下拉菜单出现两套创建逻辑。

## Resolution（D2-05a 完成情况）

把创建入口**收敛进 `WorkspaceSwitcher` 内部**（按 Note 34/35 取向）：

- 新增 `web/src/lib/create-entry.ts` 纯逻辑控制器（`createCreateEntryController`，单测 `create-entry.test.ts` 6 例）：`showEntry()=canCreate`、`openDialog`（有权限才关下拉+开对话框）、`closeDialog`（取消只关对话框）、`handleCreated`（reload 列表 + 通知 + 关对话框）。仓库无组件测试框架，acceptance #8 落在该纯逻辑 seam（与 [[d2-07i-workspace-home-and-routes]] 同一约定）。
- `WorkspaceSwitcher.svelte`：内部持有 `dialogOpen` 并渲染 `CreateWorkspaceDialog`（fixed inset:0 overlay，嵌套不被裁剪），用上述 controller 编排。`oncreate` prop **退化为可选「已创建」通知**，不再承担「打开对话框」职责——创建逻辑全仓只此一份。
- `SideNav.svelte` 去掉 `oncreateworkspace` 透传，`WorkspaceScreen.svelte` 去掉自挂的 `CreateWorkspaceDialog` / `showCreate`。
- 创建流程本身不变：仍走 D2-06 的 `createWorkspace`（`POST /api/workspaces` → silent refresh → `enterWorkspace` 新 db → URL 落 `/w/:slug`）；浏览器不持有 root / NS-admin / service token。slug 冲突 / scope-update / refresh 失败的错误显示在对话框内（D2-06 已实现），dropdown 旧状态不丢。

验收：`bun test ./src` 173 pass；`pnpm run typecheck` 0 error；`pnpm run build` 通过。
