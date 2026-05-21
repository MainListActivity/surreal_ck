Status: done
Label: done

# WP-A-01 — pnpm workspaces 骨架

## Parent

`.scratch/wp-restructure/PRD.md`

## What to build

仓库根创建 `pnpm-workspace.yaml`：

```yaml
packages:
  - 'server'
  - 'web'
  - 'shared'
```

三个 workspace 各自占位 `package.json`：

- `server/package.json`：`{ "name": "@surreal-ck/server", "private": true, "type": "module" }`
- `web/package.json`：`{ "name": "@surreal-ck/web", "private": true, "type": "module" }`
- `shared/package.json`：`{ "name": "@surreal-ck/shared", "private": true, "type": "module" }`

根 `package.json` 改：

- 顶层不再放业务依赖（仅 devDependencies / scripts）。
- 加 `"scripts": { "typecheck": "pnpm -r run typecheck" }` 等聚合脚本。
- 保留 `packageManager` 字段不动。

## Acceptance criteria

- [x] `pnpm install` 0 错误。
- [x] `pnpm ls --recursive` 列出三个 workspace。
- [x] `pnpm-lock.yaml` 重新生成（diff 内容大但变化合理）。
- [x] 顶层不再保留业务依赖（只剩 typescript / vitest / @types 等开发期工具，且这些会在簇 A-03 重新分发到各 workspace）。

## Notes

- 本 issue 不动任何源码文件，只动 package.json 与 workspace 配置。
- shared 在 simplest setup 下走 `"exports": { ".": "./src/index.ts" }`，由各 workspace 通过 `"@surreal-ck/shared": "workspace:*"` 引用。
