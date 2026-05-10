import type { AiContextSnapshot } from "../../../../shared/ai-context";
import type { AiMessageChunkEvent, AiProgressEvent } from "../../../../shared/rpc.types";
import { classifyTask, type RouterCategory, type RouterLlmCaller } from "./router-classifier";
import { runRouterDispatch, type SubAgentExecutors } from "./router-workflow";

export type RouterChatStreamPusher = (event: AiMessageChunkEvent) => void;
export type RouterChatProgressPusher = (event: AiProgressEvent) => void;

const CATEGORY_TO_AGENT_NAME: Record<RouterCategory, string> = {
  navigation: "navigationAgent",
  dashboard: "dashboardAgent",
  "claim-analysis": "claimAnalysisAgent",
  chitchat: "chitchatAgent",
};

export type RunRouterChatInput = {
  text: string;
  userContext: AiContextSnapshot;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  streamId: string;
  pushChunk: RouterChatStreamPusher;
  pushProgress?: RouterChatProgressPusher;
  /** 可选：override runId（默认自动生成） */
  runId?: string;
};

export type RunRouterChatResult = {
  runId: string;
  finalText: string;
};

export async function runRouterChat(input: RunRouterChatInput): Promise<RunRouterChatResult> {
  const runId = input.runId ?? crypto.randomUUID();
  const { streamId, pushChunk, pushProgress } = input;

  pushProgress?.({ kind: "routing", runId });
  const plan = await classifyTask({ text: input.text, llmCaller: input.llmCaller });

  // 包装 executors：在调度前推 agent-step；在 executor 完成后把 deltas 转发到 streamId 上。
  const wrapped: SubAgentExecutors = {
    navigation: makeWrapped("navigation", input.executors.navigation),
    dashboard: makeWrapped("dashboard", input.executors.dashboard),
    "claim-analysis": makeWrapped("claim-analysis", input.executors["claim-analysis"]),
    chitchat: makeWrapped("chitchat", input.executors.chitchat),
  };
  function makeWrapped(category: RouterCategory, real: SubAgentExecutors[RouterCategory]) {
    return async (args: Parameters<SubAgentExecutors[RouterCategory]>[0]) => {
      pushProgress?.({
        kind: "agent-step",
        runId,
        agentName: CATEGORY_TO_AGENT_NAME[category],
        taskText: args.taskText,
      });
      const out = await real(args);
      const deltas = out.deltas ?? (out.text ? [out.text] : []);
      for (const d of deltas) {
        if (!d) continue;
        pushChunk({ streamId, type: "delta", text: d });
      }
      return out;
    };
  }

  const dispatched = await runRouterDispatch({
    plan,
    shared: { userContext: input.userContext, confirmed: {} },
    executors: wrapped,
  });

  const finalText = dispatched.steps.map((s) => s.text).filter(Boolean).join("\n\n");

  pushChunk({
    streamId,
    type: "done",
    toolCalls: [],
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: finalText || "我没有生成有效回复。",
      createdAt: new Date().toISOString(),
      context: input.userContext,
    },
  });

  return { runId, finalText };
}
