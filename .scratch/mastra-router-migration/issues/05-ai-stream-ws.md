Status: needs-triage
Label: needs-triage

# WP-D1-05 — Hono WS endpoint：/api/chat/stream

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

> **澄清**：本 WS 仅推送 Mastra workflow 自身的 progress / chunk / suspend / done 事件。**不**转发 SurrealDB LIVE SELECT——浏览器以 admin / participant access 直接订阅 SurrealDB，参见 [`docs/adr/frontend-direct-connect.md`](../../../docs/adr/frontend-direct-connect.md)。

```
server/src/routes/ai-stream.ts
```

WS URL：`/api/chat/stream?runId=<uuid>`。

握手：

1. 客户端带 runId；鉴权优先使用 `POST /api/chat` 返回的短期 stream token，MVP 可退化为 Authorization header。
2. 服务端校验 runId 的 owner_subject 与调用者匹配（防别人监听别人的 run）。
3. 不允许把 OIDC token 放在 WebSocket query string，避免代理 / 日志泄漏。

转发协议（一类一条 JSON 行）：

```ts
| { kind: 'progress'; runId; ... }
| { kind: 'chunk'; runId; text }
| { kind: 'suspend'; runId; payload: SuspendPayload }
| { kind: 'done'; runId; message: AssistantMessage; toolCalls }
| { kind: 'error'; runId; code; message }
```

实现：

- WS 在握手时把客户端注册到内存 `RunBus`（per-process）。
- Router workflow 在跑的时候通过 `runtime.pushProgress` / `runtime.pushChunk` 等回调把事件丢给 `RunBus`。
- RunBus 把事件序列化为 JSON 发给所有该 runId 的订阅 WS（MVP 一般只有一个）。
- workflow done 或 error → 服务端关 WS。

## Acceptance criteria

- [x] 客户端先调 POST chat 拿 runId，再连 WS → 收到 progress / chunk / done 序列。
  - `attachStream` 校验 streamToken→runId→owner 通过后 `bus.subscribe`，把每条 `ChatStreamEvent` 一行 JSON 发出；`ai-stream.test.ts`「校验通过→回放+接续，done 终态后关闭」覆盖 progress→chunk→done 序列。
- [x] 客户端在 workflow 跑到一半断网重连 → 重新连 WS 能收到剩余事件（**缓存全部 + 重放**，不丢历史）。
  - 选定「缓存全部 + 重放」而非环形缓冲：RunBus 为每个 runId 保留至今所有事件，`subscribe` 时**先回放全部 backlog** 再接后续（`run-bus.test.ts`「后连上也能回放此前全部事件」+ `ai-stream.test.ts`「done 之后才连上的迟到订阅者也能回放到 done」）。
- [x] 客户端用别人的 runId 连 → 403。
  - streamToken 不匹配 / 过期 / 非本人 → `attachStream` 返回 `{ ok:false, status:403, code:"stream-forbidden" }`，**不订阅**（`ai-stream.test.ts`「token 不匹配→403 且不订阅任何事件」，验证后续 publish 不泄漏给未授权 sink）。WS 已升级时用 close code 1008 拒。
- [x] Workflow suspend 时客户端收到 `suspend` 事件，前端进入选择 UI（簇 D2 实现）。
  - `suspend` 是 `ChatStreamEvent` 一类（payload = 复用 shared `WorkflowSuspendedEvent`），RunBus 与其它非终态事件同样转发、不关闭 WS。前端选择 UI 留簇 D2。
- [x] 服务端关闭 WS 时不影响后台 workflow 继续跑——客户端可重新 POST resume / 重连 WS 拿后续事件。
  - `attachStream` 只 `bus.subscribe`，从不触碰 workflow run 本身；WS 关闭只 `detach()`（取消订阅）。后台 workflow 由 AiChatService 持有、与 WS 解耦。「缓存全部」保证重连后从头回放。

## 本轮（D1-05）实际交付

- `shared/src/rpc.types.ts`：新增 WS 转发协议 `ChatStreamEvent`（`progress` / `chunk` / `suspend` / `done` / `error` / `ping`，复用既有 `AiProgressEvent` / `WorkflowSuspendedEvent` / `AiChatMessage` / `AiToolCallRecord`）+ `CHAT_STREAM_TERMINAL_RETENTION_MS`。前后端共享同一份契约。
- `server/src/ai/run-bus.ts`：进程内 `RunBus`（`publish` / `subscribe`）。缓存全部 + 订阅即回放；`done`/`error` 终态后保留 `CHAT_STREAM_TERMINAL_RETENTION_MS`（60s）供迟到订阅，过后惰性清理。注入时钟便于测 TTL。
- `server/src/routes/ai-stream.ts`：`attachStream`（**纯函数**：registry 校验 + 订阅 + 序列化 + 终态关闭，与 Bun WSContext 解耦便于单测）+ `createAiStreamRoutes`（`upgradeWebSocket` 包 `attachStream`，25s `ping` 心跳，onClose 取消订阅）。返回 `{ routes, websocket }`。
- `server/src/app.ts`：`createApp` 现返回 `AppWithWebSocket = Hono & { websocket }`（兼容旧的 `app.fetch`/`app.request` 用法）。提升 `runRegistry` + 新增 `runBus` 为 `/api/chat` 与 `/api/chat/stream` **共用**实例；挂载 stream 路由。
- `server/src/startup.ts`：`serve()` options 增 `websocket`，把 `app.websocket` 透传给 `Bun.serve`（WS 才能升级）。
- 测试：`run-bus.test.ts`(4) + `ai-stream.test.ts`(3) + `app.test.ts` WS 接线(2) + `startup.test.ts` WS 透传(1)。`src/` 全量 99 pass / 0 fail，server tsc 0 error，shared tsc 0 error。

## Notes

- MVP 单进程后端，RunBus in-memory 即可；多副本时改 SurrealDB LIVE SELECT 或外部 pubsub（不在本 issue 范围）。
- WS 心跳：每 25s 服务端发 `{ kind: 'ping' }`，客户端不响应也 OK（仅保活）。
- 鉴权用 POST /api/chat 返回的 run-scoped `streamToken`（非 OIDC token）放 query string；OIDC token **不**入 WS query（代理 / 日志泄漏）。
- **生产装配刻意未做（同 D1-04 节奏）**：把 RunBus 的 `publish` 接到 router workflow runtime 的 `pushChunk`/`pushProgress`/`onSuspend` 回调，随生产 `AiChatService` 装配一起做——届时 `startChat` 内构造 `{ pushChunk: (e)=>bus.publish(runId,{kind:"chunk",runId,text:e.text}), pushProgress: ..., onSuspend: ... }` 传给 `createRouterWorkflow` 的 RouterRuntime，并在 workflow 结束 / 抛错时 publish `done`/`error`。本轮只交付 WS endpoint + RunBus + 接线 + 注入点。
- `attachStream` 拆成纯函数是为可测：`app.request("/api/chat/stream")` 在 `bun test` 里无 Bun `server` env，会从 `getBunServer` 抛 500——这是测试环境产物，不是路由缺陷；真实升级路径由 Bun 提供 `c.env`。app 级测试只断言该路由「非 404（已挂载）」，转发行为全在 `attachStream` 单测里覆盖。
