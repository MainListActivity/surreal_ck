Status: ready-for-agent
Label: ready-for-agent

# AI-010 — Workflow run 持久化：SurrealWorkflowsStorage

## Parent

`.scratch/agentic-ai-product/PRD.md`

## What to build

为 `src/main/ai/mastra/storage/surreal-store.ts` 新增 `SurrealWorkflowsStorage`，实现 Mastra `WorkflowsStorage` 抽象基类的全部方法，并把它接入 `SurrealMastraStore.stores`，使 router workflow 的运行快照（含暂停态）能落到 SurrealDB 并跨进程重启恢复。

这是 Router workflow + 复合意图串行 + ambiguous 暂停/恢复（issue 011 / 012）的硬前置依赖。Mastra 内置的 inmemory workflow storage 进程重启即丢，无法满足 PRD 要求的 "用户犹豫 30 分钟回来继续选候选" 场景。

**需要实现的 abstract 方法**（来自 `@mastra/core/storage/domains/workflows/base.d.ts`）：
- `supportsConcurrentUpdates(): boolean`
- `updateWorkflowResults({ workflowName, runId, stepId, result, requestContext })`
- `updateWorkflowState({ workflowName, runId, opts })`
- `persistWorkflowSnapshot({ workflowName, runId, resourceId, snapshot, createdAt, updatedAt })`
- `loadWorkflowSnapshot({ workflowName, runId })`
- `listWorkflowRuns(args?)`
- `getWorkflowRunById({ workflowName, runId })`
- `deleteWorkflowRunById({ workflowName, runId })`

**SurrealDB 表设计**（建议）：
- `mastra_workflow_run`：runId 作为主键的一部分，存 workflowName、resourceId、snapshot（JSON）、status、createdAt、updatedAt
- 字段：`workflow_name`、`run_id`、`resource_id`、`snapshot`、`status`、`created_at`、`updated_at`
- `(workflow_name, run_id)` 必须唯一，使用 `ON DUPLICATE KEY UPDATE` 处理 upsert

**接入**（`src/main/ai/mastra/storage/surreal-store.ts`）：
- 在 `SurrealMastraStore.stores` 中追加 `workflows: new SurrealWorkflowsStorage()`

**降级行为**：
- 写入失败不阻断 workflow 执行（降级为 inmemory，打印 warn 日志）
- 读取失败返回 null/空数组，让 Mastra 走 inmemory fallback

## Acceptance criteria

- [ ] `SurrealWorkflowsStorage` 实现 `WorkflowsStorage` 全部 8 个 abstract 方法
- [ ] `SurrealMastraStore.stores` 包含 `workflows` 字段
- [ ] 启动时执行的 schema 初始化包含 `mastra_workflow_run` 表定义
- [ ] 单元测试：persistWorkflowSnapshot → loadWorkflowSnapshot 往返一致
- [ ] 单元测试：listWorkflowRuns 支持按 workflowName 过滤
- [ ] 单元测试：deleteWorkflowRunById 删除后 loadWorkflowSnapshot 返回 null
- [ ] 集成测试：模拟一个 2 步的 mock workflow，第 1 步暂停后另起进程 resume 能继续到第 2 步
- [ ] 写入失败被 catch 并降级，不抛到 workflow 引擎层

## Blocked by

None — can start immediately

## Notes

- 表名前缀 `mastra_` 与既有 `mastra_memory_*` / `mastra_observability_*` 保持一致
- `supportsConcurrentUpdates()` 推荐返回 `false`（V1 不需要并发更新同一 run 的语义，简化实现）
- snapshot 字段直接存 JSON，不需要 schema 化拆解（Mastra 会自己解析）
- 不要把 `runId` 作为 SurrealDB RecordId 直接使用（runId 是 Mastra 生成的字符串，可能带特殊字符），用 `(workflow_name, run_id)` 复合索引或 hash 后做 RecordId
