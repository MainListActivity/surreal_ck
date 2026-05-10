Status: done
Label: done

# AI-003 — AI Chat RPC 合约 + 流式进度通道 + 临时 NavigationAgent 端到端贯通

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

定义 AI 通信的 RPC 合约（含流式进度通道），并在主进程用一个 **临时 NavigationAgent** 验证端到端链路。本 issue 不实现 Router workflow（issue 011）和复合意图串行（issue 012），但必须把 RPC 合约设计成对那两个 issue 前向兼容。

**RPC 合约**（添加到 `src/shared/rpc.types.ts`）：
- `ai.chat`：入参含消息文本 + AI-002 定义的结构化上下文对象；返回 AI 响应文本和可选的结构化意图（NavigationIntent / DashboardDraftIntent / RowPatchProposal）。**必须包含 `runId` 字段**，为 issue 012 的 resume 留接口
- `ai.executeAction`：入参为已确认的意图类型 + payload；主进程执行对应操作（导航/保存仪表盘/写入行）
- **`ai.progressStream`（新增）**：流式或事件订阅通道，从主进程向 renderer 推送进度事件。事件类型至少包含：
  - `{ kind: "routing"; runId }`：Router 分类中（issue 011/012 用）
  - `{ kind: "agent-step"; runId; agentName: string; taskText: string }`：当前由哪个子 agent 处理（issue 011/012 用）
  - `{ kind: "tool-call"; runId; toolId: string }`：当前正在调用的 tool

  V1 临时实现至少推 `tool-call` 事件，其它事件类型在 011/012 实施时填充。Renderer 侧消费该流并展示在 AI 抽屉的进度区。

**主进程**（`src/main/ai/`）：
- 临时实现一个 `navigationAgent` 文件（即 issue 011 将永久使用的 `src/main/ai/mastra/agents/navigation-agent.ts`），挂载 issue 04 的 4 个 nav tool
- `ai.chat` handler 调用 navigationAgent，pass-through 回复
- 当前不实现 Router workflow，但 RPC payload 中预留 `runId`（即使 V1 直接生成一个 uuid 也行）
- API key 只从 `secret-store` 读取，不传递到 renderer
- 无模型/API key 配置时返回降级响应（`{ degraded: true, message: "..." }`）
- Mastra 初始化时必须注入完整的 SurrealMastraStore（含 issue 010 的 workflows 域），否则 issue 011/012 上线时会立刻报错

**Renderer**：
- AI 抽屉的发送按钮调用 `ai.chat` RPC，渲染返回的文本消息和结构化意图卡片
- 订阅 `ai.progressStream`，在抽屉顶部展示当前进度文本（"正在调用 searchWorkbook…" 这类）

### 与 issue 011/012 的边界

- 本 issue **不创建** `workspaceAgent`。直接以 `navigationAgent` 作为 `ai.chat` 的 handler。这避免了 011 上线时还要做一次 "删除 workspaceAgent" 的破坏性变更
- 本 issue 必须保证 RPC schema 在加入 Router workflow 后**不需要破坏性修改**。`runId` 字段、`progressStream` 通道是为此预留

## Acceptance criteria

- [x] `rpc.types.ts` 中 `ai.chat`、`ai.executeAction`、`ai.progressStream` 类型定义完整，含 Zod schema 验证
- [x] `ai.chat` 返回值含 `runId` 字段
- [x] 发送消息后，AI 抽屉消息列表显示 agent 返回的文本和（若有）结构化意图卡片
- [x] AI 抽屉订阅 progressStream 并能在 tool 调用期间展示进度文本
- [x] Renderer 代码中不出现 API key 或模型密钥
- [x] 无 API key 配置时，`ai.chat` 返回降级响应而非抛出未捕获异常
- [x] `src/main/ai/mastra/agents/navigation-agent.ts` 创建完毕，挂载 issue 04 的 4 个 nav tool
- [x] Mastra 初始化使用完整 SurrealMastraStore（含 workflows 域）
- [x] `src/main/ai/index.ts` 导出 navigationAgent 工厂；不再导出 `createWorkspaceAgent` / `WORKSPACE_AGENT_ID`
- [x] RPC 序列化测试：验证 `ai.chat` 入参和返回值的 Zod 解析正确性

## Blocked by

- `.scratch/agentic-ai-product/issues/01-global-ai-drawer-skeleton.md`
- `.scratch/agentic-ai-product/issues/10-workflow-run-persistence.md`
