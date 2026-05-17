Status: needs-triage
Label: needs-triage

# WP-D2-01 — Vite 5 + Svelte 5 web 构建链

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/
  package.json
  vite.config.ts
  tsconfig.json    （簇 A-03 已建）
  index.html
  src/
    main.ts        -- mount(App, document.body)
    App.svelte     -- 占位"Hello surreal-ck"
```

`web/package.json`：

```jsonc
{
  "name": "@surreal-ck/web",
  "type": "module",
  "scripts": {
    "dev":       "vite",
    "build":     "vite build",
    "preview":   "vite preview",
    "typecheck": "tsc --noEmit && svelte-check"
  },
  "dependencies": {
    "svelte": "^5",
    "@surreal-ck/shared": "workspace:*"
  },
  "devDependencies": {
    "vite": "^5",
    "@sveltejs/vite-plugin-svelte": "^3",
    "svelte-check": "^3",
    "typescript": "^5"
  }
}
```

vite.config.ts：基础配置 + dev 代理 `/api` → `http://localhost:8080`、`/ws` → `ws://localhost:8080`。

## Acceptance criteria

- [ ] `pnpm --filter @surreal-ck/web dev` 起 Vite 在 5173，浏览器访问看到 "Hello surreal-ck"。
- [ ] `pnpm --filter @surreal-ck/web build` 生成 `web/dist/` 静态资源。
- [ ] `pnpm --filter @surreal-ck/web typecheck` 0 错误。
- [ ] dev 代理：浏览器调 `/api/health` 透传到后端。

## Notes

- 本 issue 不接业务；后续 issue 在此骨架上叠加。
- 不引入 SvelteKit；本仓库前端是纯 SPA（无 SSR），Vite 直接打包即可。
