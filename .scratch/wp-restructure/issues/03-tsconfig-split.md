Status: needs-triage
Label: needs-triage

# WP-A-03 — tsconfig 拆分

## Parent

`.scratch/wp-restructure/PRD.md`

## What to build

把根 `tsconfig.json` + `tsconfig.renderer.json` 拆为三份：

- `shared/tsconfig.json`：strict、`target: es2022`、`moduleResolution: bundler`、`outDir` 不重要（只供 typecheck）
- `server/tsconfig.json`：extends shared 风格，`types: ['bun-types']`
- `web/tsconfig.json`：extends shared 风格，`types: ['svelte', 'vite/client']`、`jsx` 配 Svelte

根目录保留一个空 `tsconfig.json` 仅作 IDE 锚点：`{ "files": [], "references": [{ "path": "shared" }, { "path": "server" }, { "path": "web" }] }`。

各 workspace 加 `"scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" }`。

## Acceptance criteria

- [ ] `pnpm -r run typecheck` 跑通（legacy 内 known errors 允许，但不能因 path 别名解析失败而挂）。
- [ ] `import { X } from '@surreal-ck/shared'` 在 server 与 web 中 IDE 跳转到 `shared/src/index.ts`。
- [ ] IDE（VSCode / IntelliJ）打开仓库时三 workspace 类型推导正常。

## Notes

- TypeScript project references 启用后 IDE 会更快，但需要 `composite: true` 与构建顺序——MVP 可不启用 references，下放到后续优化。
