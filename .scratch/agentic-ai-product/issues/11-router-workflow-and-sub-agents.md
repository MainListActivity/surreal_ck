Status: ready-for-agent
Label: ready-for-agent

# AI-011 — Router workflow + 4 个领域子 agent 拆分

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

把当前的单 `workspaceAgent` 改造为 "Router workflow + 4 个子 agent" 架构。Router 通过一次轻量 LLM 分类调用把用户消息切分为有序的 `{ category, taskText }[]` 子任务列表，按列表顺序串行调度对应的子 agent；每个子 agent 只挂载本领域所需的 tool，system prompt 不引入其它领域知识。

V1 仍然只支持 "读操作无确认串行"。复合意图串行 + ambiguous 暂停/恢复 + 写操作前确认在 issue 012 实现，本 issue 只需保证 Router workflow 的骨架能跑通线性、无暂停的多步流程（例如 "找张三"→直接返回 open-record 意图）。

### 设计契约

**Router 输出 schema**：
```ts
type RouterPlan = Array<{
  category: "navigation" | "dashboard" | "claim-analysis" | "chitchat";
  taskText: string;  // 自然语言描述，从用户原话切分而来
}>;
```

**子 agent 拆分**：
- `NavigationAgent`：挂载 `navigate` / `searchWorkbook` / `searchDashboard` / `searchRecord`（从 issue 04 的现有 tool 文件中迁移挂载点）
- `DashboardAgent`：占位 system prompt + 空 tool 列表（issue 05 注册 `inspectSchema` / `generateDashboardDraft`）
- `ClaimAnalysisAgent`：占位 system prompt + 空 tool 列表（issue 06 注册 `analyzeClaimRow` / `fetchRelatedRecords`）
- `ChitchatAgent`：无 tool，纯对话兜底，处理无法分类或闲聊场景

**共享 context 协议**：
```ts
type SharedWorkflowContext = {
  // 用户上下文（来自 AI-002 ai-context.ts），workflow 全程只读
  userContext: AiContextSnapshot;
  // 跨步骤已确认产出，每个子 agent 完成后由 workflow 引擎收集
  confirmed: {
    resolvedRecord?: { id: string; label: string };
    schemaSummary?: { tables: string[]; fieldsByTable: Record<string, string[]> };
    // 其它已确认产出按需扩展
  };
};
```
**纪律**：confirmed 字段只能写入子 agent 的最终 output，不能写入 tool call 中间结果或 LLM 原始文本。

**子 agent 输入**：
```ts
type SubAgentInput = {
  taskText: string;           // 来自 Router 的子任务描述
  shared: SharedWorkflowContext;
};
```

### 删除与迁移

- 删除 `src/main/ai/mastra/agents/workspace-agent.ts` 中的 `workspaceAgent` 实例和 `WORKSPACE_AGENT_ID` 常量
- 同步更新 `src/main/ai/index.ts` 的导出（`createWorkspaceAgent` / `WORKSPACE_AGENT_ID` 替换为新 Router workflow 的工厂）
- `src/main/ai/workspace-agent.test.ts` 改写或删除（替换为 router workflow 的入口测试）
- issue 04 的 4 个 nav tool 文件 `navigation-tools.ts` 不动，只是挂载点从 `workspaceAgent` 迁到新建的 `navigationAgent`

### Router 实现要点

- 用便宜模型（如 haiku 级）做分类，节省 token
- Router prompt 只描述 4 个 category 的语义边界，不展开各领域 tool 细节
- 输出严格 JSON，使用 zod schema 校验；解析失败时降级为单步 `chitchat` 兜底
- 流式进度：分类完成后立即向 RPC 推 "正在路由..." 类提示（具体 RPC 通道由 issue 03 提供）

## Acceptance criteria

- [ ] `src/main/ai/mastra/workflows/router-workflow.ts` 新建，使用 Mastra `createWorkflow` API
- [ ] `src/main/ai/mastra/agents/` 下新增 `navigation-agent.ts` / `dashboard-agent.ts` / `claim-analysis-agent.ts` / `chitchat-agent.ts`
- [ ] `workspace-agent.ts` 中的 `workspaceAgent` 实例和 `WORKSPACE_AGENT_ID` 被删除（文件可改名或保留为空 stub）
- [ ] `src/main/ai/index.ts` 导出新的 router workflow 入口，移除 `createWorkspaceAgent` / `WORKSPACE_AGENT_ID`
- [ ] `ai.chat` RPC（issue 03 临时实现）改为调用 router workflow 入口而非单 agent
- [ ] navigation-tools.ts 中 4 个 tool 仍能正常工作，挂载在 NavigationAgent 上
- [ ] 单元测试：Router 分类器面对 "打开工作簿 X" / "做个统计图" / "分析这条记录" / "你好" 四类输入产出正确 category
- [ ] 单元测试：Router 输出 JSON 解析失败时降级为单步 chitchat
- [ ] 集成测试：单意图 navigation 流程端到端跑通（用户消息 → router → NavigationAgent → 返回 NavigationIntent）
- [ ] 共享 context 测试：子 agent 完成后 confirmed 字段只包含已声明的已确认产出，不包含 tool call 中间结果

## Blocked by

- `.scratch/agentic-ai-product/issues/03-ai-chat-rpc-mastra-agent.md` (RPC 通道与流式进度)
- `.scratch/agentic-ai-product/issues/10-workflow-run-persistence.md` (WorkflowsStorage)

## Notes

- V1 不实现复合意图串行（Router 输出多步时本 issue 可以只串行执行最简路径，复杂暂停/恢复留给 012）
- Router 必须输出 **数组** 形式，即使是单意图也要包成长度 1 的数组，避免 012 实现时再改 schema
- 子 agent 的 system prompt 应严格限定在自己的领域；DashboardAgent 看不见 navigation tool，反之亦然
