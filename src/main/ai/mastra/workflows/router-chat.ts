import type { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import type { AiContextSnapshot } from "../../../../shared/ai-context";
import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  ResourceCitationDTO,
  AiToolCallRecord,
  WorkflowSuspendedEvent,
} from "../../../../shared/rpc.types";
import type { RouterLlmCaller } from "./router-classifier";
import {
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type RouterRuntime,
  type SubAgentExecutors,
} from "./router-workflow";

export type RouterChatStreamPusher = (event: AiMessageChunkEvent) => void;
export type RouterChatProgressPusher = (event: AiProgressEvent) => void;
export type RouterChatSuspendPusher = (event: WorkflowSuspendedEvent) => void;

export type RunRouterChatInput = {
  /** Mastra 实例：必须已通过 new Mastra({ workflows: { routerWorkflow } }) 注册了 router workflow */
  mastra: Mastra;
  text: string;
  userContext: AiContextSnapshot;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  streamId: string;
  pushChunk: RouterChatStreamPusher;
  pushProgress?: RouterChatProgressPusher;
  onSuspend?: RouterChatSuspendPusher;
  toolCalls?: AiToolCallRecord[];
  answerResourceSelection?: (input: {
    resourceIds: string[];
    taskText: string;
    userContext: AiContextSnapshot;
  }) => Promise<{ text: string; citations?: ResourceCitationDTO[] }>;
  /** 业务侧 runId（用于 progress 事件关联到 SendAiMessageResponse.runId）。
   *  传入时也作为 Mastra 的 runId，便于 ai.resumeWorkflow 用同一 id 接续。 */
  runId?: string;
};

export type RunRouterChatResult = {
  runId: string;
  finalText: string;
  status: "success" | "suspended";
};

export async function runRouterChat(input: RunRouterChatInput): Promise<RunRouterChatResult> {
  const businessRunId = input.runId ?? crypto.randomUUID();

  const runtime: RouterRuntime = {
    userContext: input.userContext,
    executors: input.executors,
    llmCaller: input.llmCaller,
    streamId: input.streamId,
    runId: businessRunId,
    pushChunk: input.pushChunk,
    pushProgress: input.pushProgress,
    onSuspend: input.onSuspend,
    toolCalls: input.toolCalls,
    answerResourceSelection: input.answerResourceSelection,
  };

  const requestContext = new RequestContext();
  requestContext.set(ROUTER_RUNTIME_KEY, runtime);

  const workflow = input.mastra.getWorkflow(ROUTER_WORKFLOW_ID);
  const run = await workflow.createRun({ runId: businessRunId });
  const result = await run.start({
    inputData: { text: input.text },
    requestContext,
  });

  if (result.status === "failed") {
    throw result.error instanceof Error ? result.error : new Error(String(result.error ?? "router workflow failed"));
  }
  if (result.status === "suspended") {
    return { runId: businessRunId, finalText: "", status: "suspended" };
  }
  if (result.status !== "success") {
    throw new Error(`router workflow ended with status="${result.status}"`);
  }

  return { runId: businessRunId, finalText: result.result.finalText, status: "success" };
}
