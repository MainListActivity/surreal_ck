Status: done
Label: done

# WP-C-01 — `_system` schema 启动期 seed

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/db/system-schema.ts   -- 启动时调，幂等
shared/sql/system/
  001-init.surql                  -- 创建 workspace + user_workspace_index + _system_schema_version 表
```

`001-init.surql` 内容对齐 [`docs/adr/workspace-as-database.md`](../../../docs/adr/workspace-as-database.md) 的 `_system` 职责。

`system-schema.ts` 行为：

- 用 root 连接 `USE NS main DB _system`（若 db 不存在则 `DEFINE DATABASE _system`）。
- 读 `_system_schema_version:current`（若表不存在则视为 0）。
- 对比代码侧版本（从 `shared/sql/system/` 目录文件名解析），按序执行未应用的 .surql 文件。
- 每应用一个文件 `UPSERT _system_schema_version:current CONTENT { version, applied_at }`。

`server/src/index.ts` 启动序列追加：

```ts
await initRootConnection();
await ensureSystemSchema();   // 新增
const server = Bun.serve(...);
```

## Acceptance criteria

- [x] 空 SurrealDB 第一次启动 → workspace / user_workspace_index / _system_schema_version 三表自动出现，`_system_schema_version:current` = 1。
- [x] 同代码重启 → _system_schema_version 不变，不重复执行。
- [x] 在 `shared/sql/system/` 加一个 `002-foo.surql` → 重启后被执行，version = 2。
- [x] 缺失 root 凭证或 SurrealDB 不可达 → ensureSystemSchema 抛错，server 不启动。

## Notes

- 选"启动时 fail-fast"而非"后台异步迁移"：MVP 单容器单副本，启动失败就重启容器，运维更简单。
- 不暴露任何 access；_system 只 root 可访问。
- 2026-05-21 TDD implementation：本地未发现 `surrealdb` skill，按 ADR 与项目 SurrealDB rules 实现。新增 `server/src/db/system-schema.test.ts` 覆盖有序执行、version 记录、幂等不重复执行；新增 `server/src/startup.test.ts` 覆盖 schema seed 成功后才监听、seed 失败不监听。
- 2026-05-21 integration check：用本地 SurrealDB 3.0.5 内存实例启动 server，首次启动创建 `workspace` / `user_workspace_index` / `_system_schema_version`，`_system_schema_version:current.version = 1`；同实例重启未重复应用 `001-init.surql`；SurrealDB 不可达时 server 以非 0 退出且未监听。
