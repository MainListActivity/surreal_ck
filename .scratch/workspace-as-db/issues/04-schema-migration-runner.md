Status: done
Label: done

# WP-C-04 — schema migration runner（既有 db 增量）

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

- [x] 在已有 N 个 workspace 的库上加一个新 surql 文件 `004-add-field.surql` → 重启后所有 ws db 都跑到 version=4。
- [x] 中间某个 ws db 跑挂 → 启动失败，但已成功迁的 db 不回滚（用户可观测 "M/N 成功"日志）。
- [x] N=0 时（无 workspace）migrateAllWorkspaces 立即返回，不报错。
- [x] 启动时只用 root 连接做迁移，不消耗任何 user / employee SIGNIN。
- [x] 与 WP-C-06 创建 workspace 复用同一个 `loadTemplateScripts()`。

## 2026-05-22 TDD slice: workspace migration runner

已完成 WP-C-04 全部垂直切片（red → green，逐个行为）：

- 新增 `server/src/db/migration-runner.ts`，导出 `migrateAllWorkspaces(db?, options?)`：
  - root `USE _system` → `SELECT db_name FROM workspace` 取所有 ws db。
  - 列表为空时立即返回 `{ total: 0, migrated: [] }`，**不**加载模板（省 IO）。
  - 对每个 ws db `USE DB` → 读 `schema_version:current`（不存在视为 0）→ 仅执行 `version > fromVersion` 的模板段 → 每段后 `UPSERT schema_version:current`。
  - 默认 `loadScripts` = `loadTemplateScripts({ oidcJwksUrl })`，与 WP-C-06 创建 workspace **共用同一份**模板；测试可注入受控脚本。
  - 任一 ws db 抛错 → fail-fast：停止后续 db、已成功的不回滚，抛出含 `M/N` 进度的 Error（`cause` 保留原始错误），并 `console.error` 输出。
  - 默认连接走 `getRootConnection()`，迁移期间不做任何 user / employee SIGNIN。
- `server/src/startup.ts` 在 `ensureSystemSchema()` 之后、`serve()` 之前调用 `migrateAllWorkspaces()`；新增可注入的 `migrateAllWorkspaces` dep。迁移失败则启动失败、不 listen。

TDD 覆盖（`bun test ./src/*.test.ts ./src/**/*.test.ts` 全绿，29 pass / 0 fail）：

- `server/src/db/migration-runner.test.ts`：落后 db 按序迁到 latest；已是 latest 的 db 不重复执行；N=0 立即返回且不加载模板；单 db 失败 fail-fast，已迁 db 不回滚、后续 db 不被 USE、错误信息含 `1/3` 进度。
- `server/src/startup.test.ts`：启动序列为 `init-root → ensure-system-schema → migrate-workspaces → create-app → listen`；迁移失败时不进入 `create-app` / `listen`。

Remaining（留给后续 issue / 运维流程，本 issue 不做）：

- 失败 ws db 的告警与手工修复流程（见 PRD 风险「workspace 创建补偿」与运维流程）。
- 用真实 SurrealDB 实例的端到端迁移演练（单元层已用 fake client + DI 覆盖行为）。

## Notes

- 这是"启动期 fail-fast"模型；上百 workspace 时启动会变慢，但 MVP 接受（参见 ADR Open Questions）。
- 失败 ws db 的告警 / 修复留给运维流程，本 issue 不实现。
- 模板每次升级都必须保持 schema 向后兼容（不允许 DROP COLUMN 影响在线业务），策略由业务侧把关。
- **新建的 db 不需要走本 runner**——WP-C-06 在创建时立即应用最新模板，schema_version 直接到 latest。本 runner 仅处理"曾经创建过、但模板已升级"的既有 db。
