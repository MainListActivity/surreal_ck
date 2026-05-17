Status: needs-triage
Label: needs-triage

# WP-D2-04 — API client（仅 Mastra endpoint）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/lib/api.ts          -- Hono client，仅对接 /api/chat* 等少数后端 endpoint
web/src/lib/ws.ts           -- WS 客户端封装（重连、心跳、JSON line 协议）
```

`auth.ts` 已由 issue 02 实现；本 issue 只用其暴露的 `getToken()`。

server workspace 在 `server/src/app.ts` 导出 `AppType`，web 通过 `import type { AppType } from '@surreal-ck/server/app-type'` 拿端到端类型。

> 注：跨 workspace 导入 type 需要 server 在 package.json 加 `"exports": { "./app-type": "./src/app.ts" }`。

api.ts 示例：

```ts
import { hc } from 'hono/client';
import type { AppType } from '@surreal-ck/server/app-type';
import { getToken } from './auth';
export const api = hc<AppType>(import.meta.env.VITE_API_BASE_URL, {
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});
```

ws.ts 接受 `{ path, params, onMessage, onClose }`，返回 `{ close() }`；25s 心跳 ping。

**本 issue 只对接 Mastra**：

- `POST /api/chat`
- `WS  /api/chat/stream`
- `POST /api/chat/runs/:runId/resume`

其它"业务 endpoint"（之前在原稿里的 sessions / members / workspaces 等）**已被 SurrealDB 直连取代**——前端直接用 `getSurreal()`（issue 03），不走本文件。

## Acceptance criteria

- [ ] `api.api.chat.$post({ json: { message } })` 调通，类型推导出 `{ runId, streamUrl }`。
- [ ] 受保护 endpoint 自动带 Authorization。
- [ ] 401 时 api.ts 抛 `OidcExpiredError`，由上层路由触发 silent refresh / 重登。
- [ ] WS 客户端能连后端 chat stream endpoint，断网重连最多 5 次。
- [ ] `/health` 等不带 Auth 的 endpoint 不带 header（通过约定或 endpoint 白名单）。

## Notes

- 不引入 trpc、不引入 react-query / svelte-query；MVP 用 svelte 5 runes 足够。
- 本 issue 的 client 仅服务于 Mastra；任何业务读写都走 `lib/surreal.ts`（issue 03）。
- WS 心跳 25s ping 防中间设备断连；断连时由 ws.ts 触发 onClose 让上层决定重连。
