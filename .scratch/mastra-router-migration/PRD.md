# Router workflow 迁入后端 PRD（簇 D1）

更新时间：2026-05-17

依据：
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)
- [`docs/adr/workspace-as-database.md`](../../docs/adr/workspace-as-database.md)
- [`docs/adr/backend-framework-hono.md`](../../docs/adr/backend-framework-hono.md)
- 既有 `.scratch/agentic-ai-product/PRD.md` 仍是事实，但执行环境从 Electrobun 主进程改为 Bun server

## 一句话

把现有 `server/legacy/ai/mastra/**`（即原 `src/main/ai/mastra/**`）的 Router workflow + 子 agent + tool **物理上**搬到 `server/ai/mastra/**`，并把所有数据库 / 上下文 / RPC 调用改为"用调用者的 SurrealDB session token 跑"，对外暴露 Hono `/api/chat` HTTP endpoint + `/api/chat/stream` WS endpoint。**不改变** Router workflow 的内部行为或 prompt。

**注意**：本簇**不**做"SurrealDB LIVE → WS 转发"——前端直接订阅 SurrealDB LIVE（参见 [`frontend-direct-connect.md`](../../docs/adr/frontend-direct-connect.md)）。本簇的 WS endpoint **仅**用于推送 Mastra workflow 自身的 progress / chunk / suspend / done 事件。

## 当前不解决

- 虚拟办公室 dispatcher（virtual-office issue 04+）
- 前端 UI 接入（簇 D2）
- 新增子 agent 或新 tool（既有的导航 / dashboard / claim-analysis / resource-retrieval 全保留）

## 前置条件

- 簇 A 完成（server/legacy 就位）
- 簇 B 完成（Hono / OIDC / root 连接）
- 簇 C 完成（用户能登录、能 sessions 进入 workspace）

## 完成定义

- `server/ai/mastra/` 目录下 router-workflow / 子 agent / tool 全部就位；`server/legacy/ai/mastra/` 被删空。
- 所有 tool 内部的 SurrealDB 调用改为接收"workspace session token"——拒绝硬编码 root 或 service 凭证。
- `WorkflowsStorage` 迁到 `_system.workflow_run` 表（schema 在簇 C-02 之外单独加，因为 Router workflow 与 virtual-office 共享）。
- HTTP `POST /api/workspaces/:slug/ai/chat`（接收用户消息）+ WS `/api/workspaces/:slug/ai/stream`（流式回 chunk / progress / suspend）就位。
- 前端在簇 D2 接入即可端到端跑通 Router workflow。

## 风险

- **既有 router-workflow.ts 与 RPC 类型耦合**（`src/shared/rpc.types.ts` 现有大量 ResolvedRecord / Suspend payload 等）：迁移时尽量保留 DTO 形状，仅把传输从 Electrobun RPC 替换为 HTTP/WS。
- **AI 上下文快照**（`shared/ai-context.ts`）当前依赖 Electrobun route 信息（screen / sidecar 等）。新 Web 形态没有 sidecar，部分字段会变 NONE 或重新设计。本簇接受"字段照搬，sidecar 永远 NONE"，后续 issue 决定是否瘦身。
- **Tool 鉴权**：每个 tool 调 SurrealDB 时必须用调用者的 session token（admin / participant），不能默认走 root；这是把 service JWT 概念彻底废掉的最后一公里。

## Issue 路线图

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | 文件搬运 + import 更新 | server/legacy/ai/mastra → server/ai/mastra；shared/ai-context.ts 等共享类型挪到 shared/src/ | wp-restructure 全部 |
| 02 | WorkflowsStorage 落 _system | 新增 workflow_run 表 schema + Mastra storage adapter | C-02 |
| 03 | Tool 鉴权重写 | 所有 tool 接收 `surrealSession`（一条已 SIGNIN 的 SurrealDB 连接）而非全局连接；删除任何 root 引用 | 01 |
| 04 | Hono endpoint：/api/workspaces/:slug/ai/chat | 接收 `{ message, contextSnapshot? }`；后端按 slug + 调用者 token SIGNIN ws db → 拉起 Router workflow run | 02, 03, C-04 |
| 05 | Hono WS endpoint：/api/workspaces/:slug/ai/stream | LIVE 转发 progress / chunk / suspend / done 事件；resume 路径走 HTTP `POST .../ai/runs/:runId/resume` | 04 |
| 06 | 删 server/legacy/ai/mastra | 物理删除原目录；确认 import 全部已迁 | 01-05 |

## 验收 KPI

- 用户在 web 抽屉（簇 D2 接入后）发"打开工作簿 X" → Router workflow 在后端跑 → 流式返回 → 前端看到结果。
- 任何 tool 调用的 SurrealDB 操作在 changefeed 中都能追溯到调用者真人 `$auth`，**没有 root 写入**。
- WorkflowsStorage 在 _system.workflow_run 表中可见，重启后未完成 run 能 resume。
- `server/legacy/ai/mastra` 目录被清空。
