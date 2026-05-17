Status: needs-triage
Label: needs-triage

# WP-C-04 — schema migration runner（既有 db 增量；前端创建新 db 时自带最新模板）

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/db/migration-runner.ts
```

启动序列：

```ts
await initRootConnection();
await ensureSystemSchema();         // _system 自身的 schema
await migrateAllWorkspaces();       // 新增：遍历所有 ws db 应用模板增量
const server = Bun.serve(...);
```

`migrateAllWorkspaces()` 行为：

1. root SELECT `_system.workspace` 拿所有 `{ db_name }`。
2. 对每个 db_name：
   - `USE DB <db_name>`
   - 读 `schema_version:current`（不存在视为 0）
   - 与代码侧 `WORKSPACE_TEMPLATE_VERSION` 比较；按序执行未应用的 .surql 文件（替换 `<__OIDC_JWKS_URL__>`）
   - 每段执行后 UPSERT schema_version
3. 任一 ws db 失败 → 整个 server 启动失败（fail-fast），便于运维介入。

日志按 ws db 输出进度（`[migration] ws_abc123: 2 → 3`）。

## Acceptance criteria

- [ ] 在已有 N 个 workspace 的库上加一个新 surql 文件 `004-add-field.surql` → 重启后所有 ws db 都跑到 version=4。
- [ ] 中间某个 ws db 跑挂 → 启动失败，但已成功迁的 db 不回滚（用户可观测 "M/N 成功"日志）。
- [ ] N=0 时（无 workspace）migrateAllWorkspaces 立即返回，不报错。
- [ ] 启动时只用 root 连接做迁移，不消耗任何 user / employee SIGNIN。

## Notes

- 这是"启动期 fail-fast"模型；上百 workspace 时启动会变慢，但 MVP 接受（参见 ADR Open Questions）。
- 失败 ws db 的告警 / 修复留给运维流程，本 issue 不实现。
- 模板每次升级都必须保持 schema 向后兼容（不允许 DROP COLUMN 影响在线业务），策略由业务侧把关。
- **新建的 db 不需要走本 runner**——前端在 DEFINE DATABASE 后立即应用最新模板，schema_version 直接到 latest。本 runner 仅处理"曾经创建过、但模板已升级"的既有 db。
