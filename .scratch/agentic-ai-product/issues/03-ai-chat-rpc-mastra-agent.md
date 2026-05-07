Status: ready-for-agent
Label: ready-for-agent

# AI-003 — AI Chat RPC 合约 + Mastra workspace agent 接入

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

定义 AI 通信的 RPC 合约，并在主进程接入 Mastra workspace agent 作为中央编排器。

**RPC 合约**（添加到 `src/shared/rpc.types.ts`）：
- `ai.chat`：入参含消息文本 + AI-002 定义的结构化上下文对象；返回 AI 响应文本和可选的结构化意图（NavigationIntent / DashboardDraftIntent / RowPatchProposal）
- `ai.executeAction`：入参为已确认的意图类型 + payload；主进程执行对应操作（导航/保存仪表盘/写入行）

**主进程**（`src/main/ai/`）：
- 在 `src/main/ai/mastra/agents/` 下创建 workspace agent，注册为 Mastra 中央编排器
- `ai.chat` handler 调用 workspace agent，agent 目前仅做 pass-through 回复（后续 issue 注册具体 tool）
- API key 只从 `secret-store` 读取，不传递到 renderer
- 无模型/API key 配置时返回降级响应（`{ degraded: true, message: "..." }`）

**Renderer**：
- AI 抽屉的发送按钮调用 `ai.chat` RPC，渲染返回的文本消息

## Acceptance criteria

- [ ] `rpc.types.ts` 中 `ai.chat` 和 `ai.executeAction` 类型定义完整，含 Zod schema 验证
- [ ] 发送消息后，AI 抽屉消息列表显示 agent 返回的文本
- [ ] Renderer 代码中不出现 API key 或模型密钥
- [ ] 无 API key 配置时，`ai.chat` 返回降级响应而非抛出未捕获异常
- [ ] Mastra workspace agent 在 `src/main/ai/index.ts` 中完成注册
- [ ] RPC 序列化测试：验证 `ai.chat` 入参和返回值的 Zod 解析正确性

## Blocked by

- `.scratch/agentic-ai-product/issues/01-global-ai-drawer-skeleton.md`
