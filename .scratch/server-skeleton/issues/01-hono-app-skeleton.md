Status: done
Label: done

# WP-B-01 — Hono app 骨架 + Bun.serve

## Parent

`.scratch/server-skeleton/PRD.md`

## What to build

```
server/
  src/
    index.ts            -- Bun.serve(app.fetch)
    app.ts              -- new Hono()，挂全局中间件 + 路由聚合
    middleware/
      logger.ts         -- 简易请求日志（method url status duration）
      error.ts          -- 兜底 onError 把异常转 { error: { code, message } }
    routes/
      health.ts         -- GET /health 占位（返回 { status: 'ok' }）
    env.ts              -- 用 zod 校验环境变量，导出强类型 env 对象
```

`server/package.json`：

```jsonc
{
  "name": "@surreal-ck/server",
  "type": "module",
  "scripts": {
    "dev":       "bun run --watch src/index.ts",
    "start":     "bun run src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4",
    "zod": "^3",
    "@surreal-ck/shared": "workspace:*"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

错误归一格式（写在 shared）：

```ts
export type ApiError = { error: { code: string; message: string; details?: unknown } };
```

## Acceptance criteria

- [x] `pnpm --filter @surreal-ck/server dev` 启动后监听 `0.0.0.0:8080`。
- [x] `curl http://localhost:8080/health` 返回 `{ "status": "ok" }`。
- [x] 抛出未捕获异常时返回 500 + `{ error: { code: 'internal', message: ... } }`，不暴露 stack 给客户端但日志中有完整 stack。
- [x] 启动日志一行包含 host、port、env name。
- [x] 缺失关键环境变量时 zod 报错并立即 exit 非 0。

## Notes

- `Bun.serve({ port, fetch: app.fetch })` 是最简写法；不引入 `@hono/node-server`。
- WS 升级在簇 D1 才需要，本 issue 不引入。
- env 暂时只校验 `PORT`（默认 8080）；其他变量随后面 issue 增量加入。
- 2026-05-21 TDD audit：新增 `server/src/app.test.ts`，覆盖 public `/health` 在未连接 DB 时仍 200/degraded、以及 Hono error body 不向客户端暴露 stack。
