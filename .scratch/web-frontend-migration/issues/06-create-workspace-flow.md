Status: needs-triage
Label: needs-triage

# WP-D2-06 — 新建 workspace 流程（Workspace Scope Module）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/lib/create-workspace.ts
web/src/components/CreateWorkspaceDialog.svelte
```

### 流程

1. 用户点"新建 workspace"按钮，填 `{ workspaceName, workspaceSlug }`。
2. 浏览器调 `POST /api/workspaces`。
3. 后端 root 创建 workspace database、应用模板、创建 owner user、写 `_system` 索引，并调用 IdP scope adapter 切到新 workspace。
4. 前端收到 `{ slug, dbName, refreshRequired: true }`。
5. 前端调用 `refresh()` silent refresh，拿到带新 `https://surrealdb.com/db` / `ac` claims 的 token。
6. 前端调用 `enterWorkspace(newToken)`，跳转 `/w/<slug>`。

### 失败处理

- `POST /api/workspaces` 返回 409：slug 已存在，表单内提示。
- 返回 `scope-update-failed`：workspace 已创建但 token scope 未切成功，UI 提供"重试进入"按钮，调用 issue 05 的 switch flow。
- 返回其它错误：保留输入，弹错误吐司。

### Acceptance criteria

- [ ] 端到端：登录 admin → 点新建 → 输 name/slug → 完成后跳转新 workspace 看到空白工作簿。
- [ ] 创建过程中 SurrealDB 不可达 → 失败提示明确；后端日志能看到补偿结果。
- [ ] slug 重复 → 409，不创建 db。
- [ ] 创建成功后新 workspace 的 user 表内有自己一条（is_admin=true）。
- [ ] 浏览器没有 NS-admin token，也不执行 `DEFINE DATABASE`。

## Blocked by

- `.scratch/web-frontend-migration/issues/04-api-client.md`
- `.scratch/web-frontend-migration/issues/05-workspace-switcher.md`
- `.scratch/workspace-as-db/issues/06-workspace-create-lifecycle.md`

## Notes

- `loadTemplateScripts()` 由后端使用；前端不 bundle `.surql` 模板。
- 是否显示"新建 workspace"由 `/api/session/workspaces` 返回的 capability 或 token claim 控制；真正安全闸门在 `POST /api/workspaces`。
