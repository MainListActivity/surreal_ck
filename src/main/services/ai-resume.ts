import type { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import type { AiContextSnapshot } from "../../shared/ai-context";
import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  ResourceCitationDTO,
  ResumeAiWorkflowResponse,
  ResumeDecision,
  WorkflowSuspendedEvent,
} from "../../shared/rpc.types";
import {
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type RouterRuntime,
  type SubAgentExecutors,
} from "../ai/mastra/workflows/router-workflow";
import type { RouterLlmCaller } from "../ai/mastra/workflows/router-classifier";

export type ResumeAiWorkflowInput = {
  mastra: Mastra;
  runId: string;
  decision: ResumeDecision;
  workflowName?: string;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  userContext: AiContextSnapshot;
  streamId: string;
  pushChunk?: (event: AiMessageChunkEvent) => void;
  pushProgress?: (event: AiProgressEvent) => void;
  onSuspend?: (event: WorkflowSuspendedEvent) => void;
  answerResourceSelection?: (input: {
    resourceIds: string[];
    taskText: string;
    userContext: AiContextSnapshot;
  }) => Promise<{ text: string; citations?: ResourceCitationDTO[] }>;
};

export async function resumeAiWorkflow(input: ResumeAiWorkflowInput): Promise<ResumeAiWorkflowResponse> {
  const workflowName = input.workflowName ?? ROUTER_WORKFLOW_ID;
  const wf = input.mastra.getWorkflow(workflowName);

  // 通过 storage 验证 run 是否存在 + 处于 suspended 状态
  const storage = input.mastra.getStorage?.();
  const stored = await storage?.stores?.workflows?.getWorkflowRunById?.({
    workflowName,
    runId: input.runId,
  });
  if (!stored) {
    return { resumed: false, status: "cancelled" };
  }

  const run = await wf.createRun({ runId: input.runId });
  const requestContext = new RequestContext();
  const runtime: RouterRuntime = {
    userContext: input.userContext,
    executors: input.executors,
    llmCaller: input.llmCaller,
    streamId: input.streamId,
    runId: input.runId,
    pushChunk: input.pushChunk,
    pushProgress: input.pushProgress,
    onSuspend: input.onSuspend,
    answerResourceSelection: input.answerResourceSelection,
  };
  requestContext.set(ROUTER_RUNTIME_KEY, runtime);

  const result = await run.resume({
    resumeData: { decision: input.decision },
    requestContext,
  });

  if (result.status === "suspended") {
    return { resumed: true, status: "suspended" };
  }
  if (result.status === "success") {
    const finalText = (result.result as { finalText?: string } | undefined)?.finalText ?? "";
    return { resumed: true, status: "success", finalText };
  }
  return { resumed: false, status: "cancelled" };
}
