Status: done
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
- ~~**生产装配刻意未做（同 D1-04 节奏）**：把 RunBus 的 `publish` 接到 router workflow runtime 的 `pushChunk`/`pushProgress`/`onSuspend` 回调，随生产 `AiChatService` 装配一起做——届时 `startChat` 内构造 `{ pushChunk: (e)=>bus.publish(runId,{kind:"chunk",runId,text:e.text}), pushProgress: ..., onSuspend: ... }` 传给 `createRouterWorkflow` 的 RouterRuntime，并在 workflow 结束 / 抛错时 publish `done`/`error`。本轮只交付 WS endpoint + RunBus + 接线 + 注入点。~~ **已完成（2026-05-28）**，见下方「D1 生产 AI 服务装配」。
- `attachStream` 拆成纯函数是为可测：`app.request("/api/chat/stream")` 在 `bun test` 里无 Bun `server` env，会从 `getBunServer` 抛 500——这是测试环境产物，不是路由缺陷；真实升级路径由 Bun 提供 `c.env`。app 级测试只断言该路由「非 404（已挂载）」，转发行为全在 `attachStream` 单测里覆盖。

## D1 生产 AI 服务装配（2026-05-28，收口）

把 D1-04 的 `aiChatService` 注入点 + D1-05 的 RunBus 串成真实可跑的 `AiChatService`，挂回 `createApp`。

- `server/src/ai/chat-service.ts`：`createAiChatService({ runBus, runner, resumer? })`——纯**桥接**层：`startChat` 用 `void` 后台跑 `runner`，把 router workflow 的 `pushChunk(delta/done/error)`/`pushProgress`/`onSuspend` 翻译成 `ChatStreamEvent` 投 RunBus；runner 抛错 → `bus.publish({kind:"error",code:"chat-failed"})`。`resumeChat` 同样后台跑 `resumer`、复用桥接。`startChat`/`resumeChat` 都立即 resolve（D1-04 契约）。
- `server/src/ai/assemble-mastra.ts`：把 `AiSettings` → 5 agents（chitchat 兼当 router LLM）→ `SubAgentExecutors` → per-run Mastra（`initMastraForCurrentUser(()=>session)`，**决策 #1**：每 run 一个 Mastra，resolver 闭包绑死本 run session，零并发串台）→ `runRouterChat` / Mastra `run.resume`，输出 `{ runner, resumer }`。
  - `buildRouterLlmCaller(agent)` = `prompt → agent.generate(prompt).text`（**决策 #2**：复用 chitchat agent 的 model，无需独立 LLM 客户端）。
  - `buildExecutors(agents, { resource? })`：navigation / dashboard / claim-analysis / chitchat 用 `makeAgentExecutor`；resource-retrieval 走 `makeResourceRetrievalExecutor`，未提供 resource deps 时不挂（plan 命中会抛 missing-executor，与 router-workflow 既有契约一致）。
  - `defaultResumeWorkflow`：对齐 legacy `resumeAiWorkflow`，差异是 runtime 里**带上调用者 surrealSession**（legacy 缺这条，D1-04 的 resume 用新 session 必须）。
- `server/src/env.ts`：新增可选 `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY` / `AI_BASE_URL`。三件齐备才接线，否则 `/api/chat` 保留 D1-04 的 **501 `ai-not-configured`**。
- `server/src/app.ts`：`buildAutoAiChatService(runBus)`——env 齐 → `createAiChatService({ runBus, runner, resumer })` 自动装配；缺任一 → undefined 落到 501 兜底。
- `.env.example`：补 `AI_*` 模板（含示例 `AI_PROVIDER=anthropic AI_MODEL=claude-sonnet-4-5`）。

**新增测试（12 条全绿）**：`chat-service.test.ts`(6) 覆盖 chunk/done/progress/suspend/error 桥接 + resume 用新 session + 未注入 resumer 抛错；`assemble-mastra.test.ts`(5) 覆盖 llmCaller 适配 + buildExecutors 4/5 形态 + createMastraRunner runner/resumer 注入；`app.test.ts`(+1) 覆盖 env 三件齐备 → `/api/chat` 不再 501。`src/` 全量 **111 pass / 0 fail**，server+shared tsc 0 error。

**测试边界**：单测全部走注入替身，不打真 LLM / 真 SurrealDB。`runRouterChat` / Mastra `run.resume` 走真实 Mastra 的端到端覆盖由既有 `ai/mastra/workflows/router-chat.test.ts` + `router-workflow-suspend.test.ts` 承担。

**唯一遗留**：把 chitchat agent 复用为 router classifier 时，`agent.generate` 会消耗 token——多任务路由时延 / 成本敏感场景可换更小模型；当前以「最小依赖装配」为准。
