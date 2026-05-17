Status: needs-triage
Label: needs-triage

# WP-D2-06 — 新建 workspace 流程（IdP + 浏览器 DDL）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/lib/create-workspace.ts
web/src/components/CreateWorkspaceDialog.svelte
```

### 流程

```
1. 用户点"新建 workspace"按钮，填 { workspaceName, workspaceSlug }
2. 浏览器调 IdP create-workspace endpoint（IdP 自家流程，含计费 / 唯一性校验）
3. IdP 返回临时 NS-admin token：
   { sub, email, ns_admin: true, current_db: ws_<nanoid>, role: 'admin', ... }
4. 浏览器（暂存当前 token，用新 NS-admin token）：
   const db = new Surreal();
   await db.connect(VITE_SURREAL_URL);
   await db.signin({ ac: 'admin', ns: 'main', token: nsAdminToken });
   await db.query('DEFINE DATABASE ' + token.current_db);
   await db.use({ ns: 'main', db: token.current_db });
   for (const script of loadTemplateScripts()) {     // 来自 shared/sql/workspace-template/
     await db.query(script.sql.replaceAll('<__OIDC_JWKS_URL__>', VITE_OIDC_JWKS_URL));
   }
   await db.signin({ ac: 'admin', ns: 'main', db: token.current_db, token: nsAdminToken });
   await db.query('CREATE user CONTENT $u', { u: { email, subject, ... } });
   await db.close();
5. 浏览器调 IdP "workspace-ready" endpoint（或等 IdP 自己通过 webhook 推后端，浏览器不参与）
6. 浏览器 silent refresh 拿"日常 token"（不带 ns_admin），进入新 workspace
```

### 失败回滚

任一步失败：

- 浏览器尝试 `REMOVE DATABASE token.current_db`（NS-admin 仍可用）。
- 调 IdP "workspace-creation-failed" endpoint 让 IdP 撤销 workspace 记录。
- 弹错误吐司，让用户重试（用新 slug，避免 IdP 那边状态卡住）。

### Acceptance criteria

- [ ] 端到端：登录 admin → 点新建 → 输 name/slug → 完成后跳转新 workspace 看到空白工作簿。
- [ ] 创建过程中 SurrealDB 不可达 → 失败提示明确，IdP 端 workspace 记录不残留（或被回调撤销）。
- [ ] 模板执行到一半失败（手动 mock DEFINE TABLE 报错）→ REMOVE DATABASE 被调用，db 不残留。
- [ ] 创建成功后**新 workspace 的 user 表内有自己一条**（is_admin=true）。
- [ ] **NS-admin token 在创建完成后立刻被丢弃**——后续日常使用走"普通 admin token"，无 ns_admin claim。

## Blocked by

- `.scratch/web-frontend-migration/issues/03-surrealdb-direct-client.md`
- `.scratch/web-frontend-migration/issues/05-workspace-switcher.md`
- `.scratch/workspace-as-db/issues/02-workspace-template-sql.md`

## Notes

- 本流程**完全不调后端 endpoint**——后端通过 IdP webhook 异步获悉新 workspace。
- `loadTemplateScripts()` 由 `@surreal-ck/shared` 提供（issue WP-C-02 落地）；前端 bundle 时把 .surql 文件作为字符串静态导入。
- IdP 的 create / workspace-ready / failed endpoint 名以 IdP 选型而定（Open Question）；本 issue 用占位名。
- 该 dialog UI 仅暴露给 IdP token 中带 `can_create_workspace: true` 的用户——前端做 UI 隐藏；真正的安全闸门在 IdP 颁发 token 时。
