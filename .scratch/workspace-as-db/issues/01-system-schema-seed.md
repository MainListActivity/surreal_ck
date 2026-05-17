Status: needs-triage
Label: needs-triage

# WP-C-01 — `_system` schema 启动期 seed

## Parent

`.scratch/workspace-as-db/PRD.md`

## What to build

```
server/src/db/system-schema.ts   -- 启动时调，幂等
shared/sql/system/
  001-init.surql                  -- 创建 workspace + user_workspace_index 表
```

`001-init.surql` 内容对齐 virtual-office/issue-01 §A（_system schema）。

`system-schema.ts` 行为：

- 用 root 连接 `USE NS main DB _system`（若 db 不存在则 `DEFINE DATABASE _system`）。
- 读 `_system.schema_version`（若表不存在则视为 0）。
- 对比代码侧版本（从 `shared/sql/system/` 目录文件名解析），按序执行未应用的 .surql 文件。
- 每应用一个文件 `UPSERT schema_version:current CONTENT { version, applied_at }`。

`server/src/index.ts` 启动序列追加：

```ts
await initRootConnection();
await ensureSystemSchema();   // 新增
const server = Bun.serve(...);
```

## Acceptance criteria

- [ ] 空 SurrealDB 第一次启动 → workspace / user_workspace_index 两表自动出现，`schema_version:current` = 1。
- [ ] 同代码重启 → schema_version 不变，不重复执行。
- [ ] 在 `shared/sql/system/` 加一个 `002-foo.surql` → 重启后被执行，version = 2。
- [ ] 缺失 root 凭证或 SurrealDB 不可达 → ensureSystemSchema 抛错，server 不启动。

## Notes

- 选"启动时 fail-fast"而非"后台异步迁移"：MVP 单容器单副本，启动失败就重启容器，运维更简单。
- 不暴露任何 access；_system 只 root 可访问。
