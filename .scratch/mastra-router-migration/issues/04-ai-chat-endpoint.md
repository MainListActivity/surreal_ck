Status: done
Label: needs-triage

# WP-D1-04 — Hono endpoint：POST /api/chat

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

```
server/src/routes/ai-chat.ts
```

入参：

```ts
{
  message: string;
  contextSnapshot?: AiContextSnapshot;   // shared/src/ai-context.ts，sidecar 字段允许 NONE
  resume?: { runId: string; decision: ResumeDecision };  // 若 resume 已有暂停 run
}
```

流程：

1. requireOidc + 读取 token 中 `https://surrealdb.com/db` / `https://surrealdb.com/ac` scope，SIGNIN 得到 `surrealSession`（admin 或 participant）。
2. 创建一个 `runId = nanoid()`。
3. 启动 Router workflow（用 `surrealSession` + `contextSnapshot` + `message`），把 `runId` 注册到 Mastra storage。
4. 生成短期 `streamToken`（run-scoped，TTL 5 分钟），立即 200 返回 `{ runId, streamUrl: '/api/chat/stream?runId=...', streamToken }`。
5. workflow 在后端继续跑；客户端在簇 D1-05 的 WS endpoint 监听 progress / chunk。

resume 路径：

- 若入参有 `resume`，找到对应 runId 的 suspended run，调 Mastra resume API + 提交 decision。

## Acceptance criteria

- [x] 调用者无效 OIDC token → 401。
  - `ai-chat.test.ts`「缺 Bearer token → 401」走真实 `requireOidc`。
- [x] token scope 指向的 workspace 不存在或 access SIGNIN 失败 → 401 / 403。
  - `createCallerSession` 的 `authenticate(rawToken)` 被 DB 引擎拒绝时向上抛，路由 catch 后翻成 **403 `chat-signin-failed`**（`ai-chat.test.ts`「SIGNIN 失败 → 403，且不启动 workflow」+ `caller-session.test.ts` 抛错用例）。
  - ⚠️ 真实 db-not-found / AUTHENTICATE THROW 是 DB 引擎行为，需 live SurrealDB 集成测试；本轮以假 factory 抛错替身覆盖「factory 抛 → 403 且不启 workflow」。
- [x] 成功调用立即返回 runId + streamToken，workflow 在后台启动。
  - 返回 `{ runId, streamUrl: '/api/chat/stream?runId=...', streamToken }`；`service.startChat` 用调用者 session + message + 同一 runId 被调用（`startChat` 立即 resolve = 后台启动语义）。
- [x] 同一调用者并发两次 chat → 两个独立 runId，互不干扰。
  - `ai-chat.test.ts`「并发两次 → 两个独立 runId」：registry 各注册一条、owner 为调用者、streamToken 各自配对。
- [x] resume 路径：把上次 suspend 的 run 推进到下一步（无须重新 SIGNIN）。
  - `resume: { runId, decision }` → registry owner 校验（非本人持有统一 403，不泄漏 run 是否存在）→ **新 session** authenticate → `service.resumeChat({ runId, decision, surrealSession })`，刷新 streamToken/TTL 供 WS 重连。

## 本轮（D1-04）实际交付

- `server/src/routes/ai-chat.ts`：`createAiChatRoutes({ service, createCallerSession, registry, requireUser })`。`POST /api/chat` 分新 run / resume 两路；session 创建失败统一 403；resume 入参用 `ResumeAiWorkflowRequestSchema` 校验。
- `server/src/ai/caller-session.ts`：`createCallerSession(rawToken)` = `connect` + `authenticate(rawToken)`，**不 use()**（JWT token 自带 db/ac scope，DB 引擎在 authenticate 时校验并落库）。**无 root/service 兜底**。
- `server/src/ai/run-registry.ts`：进程内 `RunRegistry`（runId→owner + streamToken，TTL 5min）。`register` mint token、`get` 取记录、`resolveStreamToken` 供簇 D1-05 WS 握手校验。
- `server/src/app.ts`：`/api/chat` 挂载进 `createApp`；新增可注入 `aiChatService` / `createCallerSession` / `runRegistry`。**未注入 AI 服务时返回 501 `ai-not-configured`**（不是 404 / 静默 500）。
- 测试：`ai-chat.test.ts`(7) + `caller-session.test.ts`(2) + `run-registry.test.ts`(4) + `app.test.ts` 两条集成。server 全量 91 pass / 0 fail，`tsc --noEmit` 0 error。

## Notes

- 不在本 endpoint 同步等 workflow 完成——前端必须订阅 WS。
- 默认 1 个 user 同 workspace 不限制并发 run，但单 run 内步数受 Mastra workflow 自身保护。
- resume 用**新 session**（OIDC token 可能已刷新），workflow state 不持有 session 引用，只持有 surql 输入——已落实。
- **生产 `AiChatService` 装配（真 agents → `SubAgentExecutors` + `RouterLlmCaller` → `runRouterChat`）本轮刻意未做**：仓里还没有生产装配点，且这块是独立大件。本轮只交付路由 + caller-session + registry + resume + 注入点；`createApp` 默认 service 返回 501。后续接线时把真 service 注入 `createApp({ aiChatService })`，并在其中用 `surrealSession` 初始化 `SurrealMastraStore`（`initMastraForCurrentUser`）后调 `runRouterChat`。
- RunBus（事件缓冲 / 推送）与 WS 本体在簇 D1-05；本注册表只负责 owner + streamToken 生命周期，已为 05 的握手校验预留 `resolveStreamToken`。
