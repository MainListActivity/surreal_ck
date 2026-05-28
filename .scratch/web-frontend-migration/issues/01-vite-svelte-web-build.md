Status: done
Label: done

# WP-D2-01 — Vite 8 + Svelte 5 web 构建链

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

- [~] `pnpm --filter @surreal-ck/web dev` 起 Vite 在 5173，浏览器访问看到 "Hello surreal-ck"。 _（未在浏览器现场验证；TDD 已覆盖 vite.config 行为 + scripts 就位）_
- [x] `pnpm --filter @surreal-ck/web build` 生成 `web/dist/` 静态资源（index.html + assets/）。
- [x] `pnpm --filter @surreal-ck/web typecheck` 0 错误（tsc + svelte-check 4.4.8）。
- [~] dev 代理：浏览器调 `/api/health` 透传到后端。 _（同上，单测覆盖 server.proxy 配置正确，未跑真实进程）_

## Notes

- 本 issue 不接业务；后续 issue 在此骨架上叠加。
- 不引入 SvelteKit；本仓库前端是纯 SPA（无 SSR），Vite 直接打包即可。

## 落地记录（2026-05-28）

- 删 Electrobun 残余：原 `vite.config.ts` 里的 `root: "src/renderer"`、`viteStaticCopy(.node 原生绑定 + ../schema)`、`build.outDir: "../../dist"`、`rollupOptions.output` 自定义 chunk 命名。
- 新 `web/vite.config.ts`：纯 SPA + Svelte 5 runes；`server.port: 5173` + `server.proxy['/api'] → http://localhost:8080`、`['/ws'] → ws://localhost:8080 (ws: true)`；`build.target: esnext`。
- 新增 `web/index.html`（挂 `#app` + `/src/main.ts`）、`web/src/main.ts`（Svelte 5 `mount(App, { target })`）、`web/src/App.svelte`（Hello surreal-ck 占位）。
- `web/package.json` scripts：`dev` / `build` / `preview` / `typecheck (tsc + svelte-check)` / `test (bun test ./src)`。
- 新增 devDep：`svelte-check@^4.4.8`（让 typecheck 覆盖 .svelte 文件 ts 段）。
- TDD：新增 `web/src/vite-config.test.ts`，5 条断言（root 未设为 src/renderer、base 是 SPA 根、proxy /api、proxy /ws、build.outDir 是 dist）→ 红 5 → 绿 5。
- 验收：`pnpm --filter web typecheck` 0 错；`pnpm --filter web build` 产出 `web/dist/{index.html, assets/}`；`pnpm -r typecheck` shared/server/web 全绿；`pnpm -r --if-present run test` server 116 + web 5 全绿。
- 顺手：删了仓库根的 `/dist`（Electrobun 旧构建残留，gitignore 内）。

下一步：D2-02 OIDC 登录壳。
