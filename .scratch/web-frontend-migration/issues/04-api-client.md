Status: done
Label: needs-triage

# WP-D2-04 — API client（Workspace Scope + Mastra）

## Parent

`.scratch/web-frontend-migration/PRD.md`

## What to build

```
web/src/lib/api.ts          -- Hono client，对接 Workspace Scope Module + /api/chat*
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

**本 issue 对接的后端 endpoint**：

- `GET /api/session/workspaces`
- `POST /api/session/switch-workspace`
- `POST /api/workspaces`
- `POST /api/chat`
- `WS  /api/chat/stream`
- `POST /api/chat/runs/:runId/resume`

其它业务数据 endpoint（工作簿 / 数据表 / office_* CRUD / LIVE）不存在——前端直接用 `getSurreal()`（issue 03）。

## Acceptance criteria

- [x] `api.api.chat.$post({ json: { message } })` 调通，类型推导出 `{ runId, streamUrl, streamToken }`。
- [x] 受保护 endpoint 自动带 Authorization。
- [x] 401 时 api.ts 抛 `OidcExpiredError`，由上层路由触发 silent refresh / 重登。
- [x] WS 客户端能连后端 chat stream endpoint，断网重连最多 5 次。
- [x] `/health` 等不带 Auth 的 endpoint 不带 header（通过约定或 endpoint 白名单）。

## 实现说明（D2-04 完工）

- `web/src/lib/api.ts`：`createApiClient({ baseUrl, getToken, fetch })` 包 `hc<AppType>`；authedFetch 注入 Authorization（公开前缀白名单 `/health`），401 抛 `OidcExpiredError`。默认导出 `api`。
- `web/src/lib/ws.ts`：`connectWs({ url, params, onMessage, onClose, socketFactory, timers })`；JSON-line 解析、25s ping、指数退避重连最多 5 次、主动 close 不重连/不回调。WsSocket/WsTimers 切面便于注入 fake 单测。
- 端到端类型：server `exports['./app-type']` 指向 emit 出的 `dist/server/src/app.d.ts`（`tsconfig.build.json` + `build:types`）；shared 同样 emit `dist/sql/workspace-template/index.d.ts` 避免把 Bun-runtime 源拖进 web typecheck。web tsconfig path alias 指向这些 `.d.ts`；`web typecheck` 经 `build:upstream-types` 先 emit。
- 测试：`web/src/lib/api.test.ts`（3）+ `web/src/lib/ws.test.ts`（5），全绿；`vite build` 验证 type-only import 被擦除、web 无 server 运行时依赖。

## Notes

- 不引入 trpc、不引入 react-query / svelte-query；MVP 用 svelte 5 runes 足够。
- 本 issue 的 client 服务于 Workspace Scope Module 与 Mastra；任何业务读写都走 `lib/surreal.ts`（issue 03）。
- WS 心跳 25s ping 防中间设备断连；断连时由 ws.ts 触发 onClose 让上层决定重连。
