Status: done
Label: ready-for-agent

# AI-008 — Mastra 可观测性：存储 + tool call 日志

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

将 Mastra 的对话存储和 tool call 日志接入已有的 SurrealDB 存储适配器和 audit 体系，使 AI 请求和工具调用可被调试和审计。

**存储接入**：
- 完善 `src/main/ai/mastra/storage/surreal-store.ts` 骨架，实现 Mastra storage 接口，将对话历史（thread/message）写入 SurrealDB
- 在 Mastra 初始化（`src/main/ai/index.ts`）中注入此存储适配器

**Tool call 日志**：
- 每次 Mastra tool 被调用时，向已有 `audit` 服务写入一条日志记录，包含：tool 名称、入参摘要、返回意图类型、时间戳、关联 session ID
- 日志不存储完整行数据或 AI 原始 prompt，只存意图类型和关键标识符

**可观测性不包含**：
- 管理员专用 UI 面板（当前迭代范围外）
- 完整的 prompt evaluation 基础设施（Out of Scope）

## Acceptance criteria

- [x] `surreal-store.ts` 实现 Mastra storage 接口，thread 和 message 写入 SurrealDB
- [x] 重启应用后，对话历史可从 SurrealDB 恢复（Mastra 内部消费，不需要 UI 展示）
- [x] 每次 tool 调用在 audit 表中产生一条记录（tool 名称、意图类型、时间戳）
- [x] audit 记录不包含 API key 或完整 prompt 文本
- [x] 存储失败不阻断正常 AI 对话流程（降级：跳过写入，打印日志）

## Blocked by

- `.scratch/agentic-ai-product/issues/03-ai-chat-rpc-mastra-agent.md`
