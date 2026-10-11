# 行分析提案路径：reasoning 模型空输出与流中断的显式收尾

任务 a6d47640（def-row-analysis-no-proposal，blocker）。生产实测（任务 04014d5f，origin sha 467bf8c6，工作区 sck-lca10-qa-ui01）：管理员对空状态行发起 AI 行分析两次全败——fv02-2 `row-analysis-agent` 单次调用 output=177 tokens 全部 reasoningTokens、零可见文本，前端回退「我没有生成有效回复。」；fv02-4 长推理 3848 tokens 后 provider 流中途断，只剩通用「AI 服务暂时不可用」。同会话同模型 `llm-classify` 与 `chitchat-agent` 均正常，故障限定在「工具 + 多步 + 推理模型」的行分析/提案路径。

## 根因

1. `makeAgentExecutor` 只消费 `stream.textStream`——Mastra 的 textStream 仅透传 `text-delta` part，reasoning 模型（sensenova-6.8-flash-lite）把全部产出放在 reasoning 通道时，文本被整体丢弃，最终 `text` 为空。
2. 空 `text` 被 router-workflow finalize 的兜底文案「我没有生成有效回复。」接管——隐藏失败伪装成有效回复，用户与账本都无法区分「模型选择不答」和「模型只思考不落地」。
3. 流中途失败（provider 断流）经 `describeRunFailure` 链路丢失类型信息，前端只能映射到笼统的「服务不可用」。

## 修复

- `server/ai/mastra/workflows/agent-executor.ts`：改消费 `fullStream`，显式区分 `text-delta` / `reasoning-delta` / `error` part。reasoning 内容不进用户可见流，只用于归类。无可见产出且未产生 suspend 提案时上报 `noOutput: "reasoning-only" | "empty"`；配了 `noOutputText` 的 executor（生产仅 row-analysis）用契约文案替换空文本。error part 与 `stream.error` 任一出现都抛 `AgentStreamInterruptedError`（`code=ai-stream-interrupted`，稳定用户文案，原始 cause 保留在 error 上供服务端日志）。
- `server/ai/mastra/agents/row-analysis-agent.ts`：新增 `ROW_ANALYSIS_NO_PROPOSAL_TEXT` 契约文案；instructions 增加输出契约——每轮思考必须落地为工具调用或一句明确结论，禁止只推理不输出；无法给出建议时显式传空 `suggestions`。
- `server/src/ai/assemble-mastra.ts`：`buildExecutors` 给 row-analysis executor 配 `noOutputText`。
- `web/src/lib/ai-drawer.ts`：`aiErrorMessage` 把流中断映射为「AI 生成中断：本次未产出完整结果，请重试。」，与未知故障区分。
- 空提案（模型显式传空 suggestions）不出卡片（不伪造提案），但收尾是显式 no-proposal 态；可编辑字段过滤（系统字段 / `fieldType=unknown` / 不存在字段）继续阻止错误提案。

## 验证

```sh
cd server && bun test ai/mastra/workflows/agent-executor.test.ts ai/mastra/workflows/agent-executor-session.test.ts ai/mastra/workflows/router-chat.test.ts ai/mastra/agents/row-analysis-agent.test.ts ai/mastra/tools/row-analysis-tools.test.ts src/ai/assemble-mastra.test.ts --preload ./test/setup-env.ts
cd web && bun test src/lib/ai-drawer.test.ts
```

覆盖：reasoning-only → 显式 no-proposal（单测 + 工作流级 done 消息断言）、推理后仍有文本 → 正常收尾、流中途 error part → `AgentStreamInterruptedError` 而非空回复、空提案 → 不 suspend + 契约文案。注意：本机全量 `bun test` 有 12 个既有环境相关失败（真实 SurrealDB 引擎 / OIDC JWKS fixture），与本次改动无关（base 同集失败）。

生产 AC 仍待上线后在 ui01 用既有夹具行实测（部署腿任务）：产出可见提案卡或契约化 no-proposal 显式态且零运行时错误；不提高限额、不改账本历史。
