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

- [ ] 客户端先调 POST chat 拿 runId，再连 WS → 收到 progress / chunk / done 序列。
- [ ] 客户端在 workflow 跑到一半断网重连 → 重新连 WS 能收到剩余事件（要求 RunBus 缓存最近 N 条事件，可加可不加，MVP 接受丢部分历史）。
- [ ] 客户端用别人的 runId 连 → 403。
- [ ] Workflow suspend 时客户端收到 `suspend` 事件，前端进入选择 UI（簇 D2 实现）。
- [ ] 服务端关闭 WS 时不影响后台 workflow 继续跑——客户端可重新 POST resume / 重连 WS 拿后续事件。

## Notes

- MVP 单进程后端，RunBus in-memory 即可；多副本时改 SurrealDB LIVE SELECT 或外部 pubsub（不在本 issue 范围）。
- WS 心跳：每 25s 服务端发 `{ kind: 'ping' }`，客户端不响应也 OK（仅保活）。
