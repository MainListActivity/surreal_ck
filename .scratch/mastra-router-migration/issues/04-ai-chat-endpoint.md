Status: needs-triage
Label: needs-triage

# WP-D1-04 — Hono endpoint：POST /api/workspaces/:slug/ai/chat

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

1. requireOidc + 按 slug + 调用者 token 调 sessions 内部 sign-in 函数得到 `surrealSession`（admin 或 participant）。
2. 创建一个 `runId = nanoid()`。
3. 启动 Router workflow（用 `surrealSession` + `contextSnapshot` + `message`），把 `runId` 注册到 Mastra storage。
4. 立即 200 返回 `{ runId, streamUrl: '/api/workspaces/:slug/ai/stream?runId=...' }`。
5. workflow 在后端继续跑；客户端在簇 D1-05 的 WS endpoint 监听 progress / chunk。

resume 路径：

- 若入参有 `resume`，找到对应 runId 的 suspended run，调 Mastra resume API + 提交 decision。

## Acceptance criteria

- [ ] 调用者无效 OIDC token → 401。
- [ ] 调用者不是 workspace 成员 → 401。
- [ ] 成功调用立即返回 runId，workflow 在后台启动。
- [ ] 同一调用者并发两次 chat → 两个独立 runId，互不干扰。
- [ ] resume 路径：把上次 suspend 的 run 推进到下一步（无须重新 SIGNIN）。

## Notes

- 不在本 endpoint 同步等 workflow 完成——前端必须订阅 WS。
- 默认 1 个 user 同 workspace 不限制并发 run，但单 run 内步数受 Mastra workflow 自身保护。
- resume 必须复用原 surrealSession 还是允许新 session？倾向"新 session"（OIDC token 可能已刷新），workflow state 不持有 session 引用，只持有 surql 输入。
