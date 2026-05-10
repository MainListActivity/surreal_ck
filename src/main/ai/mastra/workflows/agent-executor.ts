import type { Agent } from "@mastra/core/agent";
import type { AiToolCallRecord } from "../../../../shared/rpc.types";
import { serializeContextForAi } from "../../../../shared/ai-context";
import type { SubAgentExecutor } from "./router-workflow";

export type AgentExecutorOptions = {
  /** 调用 agent 时透传给 stream() 的最大步数。默认 4。 */
  maxSteps?: number;
  /** 收集 tool 调用时的回调（runId 由 router-chat 注入）。 */
  onToolCall?: (call: AiToolCallRecord) => void;
};

/**
 * 把 Mastra Agent 适配成 SubAgentExecutor。
 * - taskText + shared 序列化为单条 user 消息
 * - 通过 textStream 收集 deltas，让 router-chat 转推到统一 streamId 上
 */
export function makeAgentExecutor(agent: Agent, options: AgentExecutorOptions = {}): SubAgentExecutor {
  return async ({ taskText, shared }) => {
    const prompt = [
      `子任务：${taskText}`,
      "",
      "用户上下文快照：",
      JSON.stringify(serializeContextForAi(shared.userContext), null, 2),
      "",
      "已确认产出（前置步骤产生）：",
      JSON.stringify(shared.confirmed, null, 2),
    ].join("\n");

    const stream = await agent.stream(
      [{ role: "user", content: prompt }],
      {
        maxSteps: options.maxSteps ?? 4,
        onStepFinish: ({ toolCalls, toolResults }) => {
          if (!toolResults?.length) return;
          const stepResults = toolResults as unknown as Array<{
            toolCallId: string;
            toolName: string;
            args?: unknown;
            result: unknown;
          }>;
          const callList = toolCalls as unknown as Array<{ toolCallId: string; args?: unknown }>;
          for (const tr of stepResults) {
            const call = callList?.find((tc) => tc.toolCallId === tr.toolCallId);
            options.onToolCall?.({
              toolName: tr.toolName,
              args: call?.args ?? tr.args,
              result: tr.result,
            });
          }
        },
      },
    );

    const deltas: string[] = [];
    let aggregated = "";
    for await (const delta of stream.textStream) {
      if (!delta) continue;
      deltas.push(delta);
      aggregated += delta;
    }
    const text = aggregated || (await stream.text) || "";
    return { text, confirmed: {}, deltas };
  };
}
