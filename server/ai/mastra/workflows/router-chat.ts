import type { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import type { Surreal } from "surrealdb";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  ResourceCitationDTO,
  AiToolCallRecord,
  WorkflowSuspendedEvent,
} from "@surreal-ck/shared";
import type { RouterLlmCaller } from "./router-classifier";
import type { DecisionCaller } from "../../decision/model";
import {
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type OpenContentResearchSession,
  type RouterRuntime,
  type SubAgentExecutors,
} from "./router-workflow";
import { setExecutionContext } from "../execution-context";
import type { RouterPlan } from "./router-classifier";

export type RouterChatStreamPusher = (event: AiMessageChunkEvent) => void;
export type RouterChatProgressPusher = (event: AiProgressEvent) => void;
export type RouterChatSuspendPusher = (event: WorkflowSuspendedEvent) => void;

export type RunRouterChatInput = {
  /** Mastra 实例：必须已通过 new Mastra({ workflows: { routerWorkflow } }) 注册了 router workflow */
  mastra: Mastra;
  text: string;
  userContext: AiContextSnapshot;
  /** 调用者 SurrealDB 会话：用其 OIDC token 走 admin/participant access SIGNIN 得到，贯穿整个 run 的 tool 调用。 */
  surrealSession: Surreal;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  /** 可选决策模型：意图分类的单意图捷径；缺席时纯 LLM 分类。 */
  decisionModel?: DecisionCaller;
  /** 决策置信度阈值；默认 router-classifier 内 0.75。 */
  jevConfidenceThreshold?: number;
  planOverride?: RouterPlan;
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
  /** LCA06：调用者 content_reader 窗口工厂；缺席时 resource-retrieval 不做平台语料研究。 */
  openContentSession?: OpenContentResearchSession;
  /** 业务侧 runId（用于 progress 事件关联到 SendAiMessageResponse.runId）。
   *  传入时也作为 Mastra 的 runId，便于 ai.resumeWorkflow 用同一 id 接续。 */
  runId?: string;
};

export type RunRouterChatResult = {
  runId: string;
  finalText: string;
  status: "success" | "suspended";
};

/**
 * Mastra `run.start()` 失败时 `result.error` 是序列化后的纯对象
 * （`errorInstance.toJSON()`：`{message, name?, code?, details?, cause?}`），
 * `instanceof Error` 恒为 false；直接 `String()` 会得到 "[object Object]"。
 * 沿 message/cause 链把可读信息还原出来。
 */
function describeRunFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  const messages: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth += 1) {
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && message && !messages.includes(message)) {
      messages.push(message);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return messages.length ? messages.join(" | caused by: ") : String(error ?? "router workflow failed");
}

export async function runRouterChat(input: RunRouterChatInput): Promise<RunRouterChatResult> {
  const businessRunId = input.runId ?? crypto.randomUUID();

  const runtime: RouterRuntime = {
    userContext: input.userContext,
    surrealSession: input.surrealSession,
    executors: input.executors,
    llmCaller: input.llmCaller,
    decisionModel: input.decisionModel,
    jevConfidenceThreshold: input.jevConfidenceThreshold,
    planOverride: input.planOverride,
    streamId: input.streamId,
    runId: businessRunId,
    pushChunk: input.pushChunk,
    pushProgress: input.pushProgress,
    onSuspend: input.onSuspend,
    toolCalls: input.toolCalls,
    answerResourceSelection: input.answerResourceSelection,
    openContentSession: input.openContentSession,
  };

  const requestContext = new RequestContext();
  // Router run 也走共享执行上下文 seam 注入调用者会话；Router 私有运行时仍走 ROUTER_RUNTIME_KEY。
  setExecutionContext(requestContext, { surrealSession: input.surrealSession });
  requestContext.set(ROUTER_RUNTIME_KEY, runtime);

  const workflow = input.mastra.getWorkflow(ROUTER_WORKFLOW_ID);
  const run = await workflow.createRun({ runId: businessRunId });
  const result = await run.start({
    inputData: { text: input.text },
    requestContext,
  });

  if (result.status === "failed") {
    throw new Error(describeRunFailure(result.error));
  }
  if (result.status === "suspended") {
    return { runId: businessRunId, finalText: "", status: "suspended" };
  }
  if (result.status !== "success") {
    throw new Error(`router workflow ended with status="${result.status}"`);
  }

  return { runId: businessRunId, finalText: result.result.finalText, status: "success" };
}
