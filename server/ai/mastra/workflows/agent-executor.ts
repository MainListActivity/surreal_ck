import { internalScope } from "../../../src/internal-ai/context";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import type { AiStructuredIntent, AiToolCallRecord, ResourceCitationDTO } from "@surreal-ck/shared";
import { serializeContextForAi } from "@surreal-ck/shared";
import { ROUTER_RUNTIME_KEY, type SharedConfirmed, type SubAgentExecutor, type SubAgentSuspendSignal } from "./router-workflow";
import { setExecutionContext } from "../execution-context";

export type AgentExecutorOptions = {
  /** 调用 agent 时透传给 stream() 的最大步数。默认 4。 */
  maxSteps?: number;
  /** 收集 tool 调用时的回调（runId 由 router-chat 注入）。 */
  onToolCall?: (call: AiToolCallRecord) => void;
  /**
   * 无可见产出（reasoning 模型只思考不落地）时替换空文本的显式收尾文案。
   * 缺席时保持历史行为：text 返回空串，由上游兜底——调用方负责不把空回复
   * 伪装成有效回答（def-row-analysis-no-proposal 的生产故障形态）。
   */
  noOutputText?: string;
};

/**
 * 无可见产出的显式归类（仅当最终 text 为空且未产生 suspend 提案时上报）：
 * - `reasoning-only`：模型只输出推理内容，没有文本、也没有工具调用；
 * - `empty`：没有任何可见输出（含调了工具但无可确认产出的情形）。
 */
export type AgentExecutorNoOutput = "reasoning-only" | "empty";

/**
 * LLM 流中途失败（provider 断流 / 网关错误）的显式错误态。
 * 面向用户只呈现稳定文案；原始 cause 保留在 error 上供服务端日志定位，
 * 不进入用户可见消息（不得泄露内部错误细节，也不得退化成空回复）。
 */
export class AgentStreamInterruptedError extends Error {
  readonly code = "ai-stream-interrupted";
  constructor(cause: unknown) {
    super("AI 生成流中断：本次未产出完整结果，请重试。");
    this.cause = cause;
  }
}

const SchemaSummarySchema = z.object({
  tables: z.array(z.string()),
  fieldsByTable: z.record(z.string(), z.array(z.string())),
});

const ResourceCitationListSchema = z.array(z.object({
  index: z.number().int().positive(),
  resourceId: z.string(),
  title: z.string(),
  sourceUrl: z.string().optional(),
  evidence: z.array(z.object({
    order: z.number().int().nonnegative(),
    text: z.string(),
  })).optional(),
}));

/**
 * 把 Mastra Agent 适配成 SubAgentExecutor。
 * - taskText + shared 序列化为单条 user 消息
 * - 通过 fullStream 收集 text deltas（reasoning 只做归类、不进可见流），
 *   让 router-chat 转推到统一 streamId 上
 */
export function makeAgentExecutor(agent: Agent, options: AgentExecutorOptions = {}): SubAgentExecutor {
  return async ({ taskText, shared, surrealSession, onDelta }) => {
    const prompt = [
      `子任务：${taskText}`,
      "",
      "用户上下文快照：",
      JSON.stringify(serializeContextForAi(shared.userContext), null, 2),
      "",
      "已确认产出（前置步骤产生）：",
      JSON.stringify(shared.confirmed, null, 2),
    ].join("\n");

    // 会话走共享执行上下文 seam（tool 只从这里取）；Router 私有数据留在 ROUTER_RUNTIME_KEY。
    const requestContext = new RequestContext();
    if (surrealSession) {
      setExecutionContext(requestContext, { surrealSession });
    }
    requestContext.set(ROUTER_RUNTIME_KEY, { userContext: shared.userContext });

    const observedToolCalls: AiToolCallRecord[] = [];
    const stream = await agent.stream(
      [{ role: "user", content: prompt }],
      {
        requestContext,
        ...(internalScope() ? { modelSettings: { maxRetries: 0 } } : {}),
        maxSteps: options.maxSteps ?? 4,
        onStepFinish: ({ toolCalls, toolResults }) => {
          if (!toolResults?.length) return;
          // Mastra 回调里 toolCalls/toolResults 是 ChunkType：字段在 payload 内。
          // 同时容忍顶层平铺与 input/output 命名，避免上游再改形状时静默丢结果。
          const callArgsById = new Map<string, unknown>();
          for (const tc of toolCalls ?? []) {
            const payload = stepChunkFields(tc);
            if (typeof payload?.toolCallId === "string") {
              callArgsById.set(payload.toolCallId, payload.args ?? payload.input);
            }
          }
          for (const tr of toolResults as unknown[]) {
            const payload = stepChunkFields(tr);
            if (typeof payload?.toolName !== "string") continue;
            const record: AiToolCallRecord = {
              toolName: payload.toolName,
              args: (typeof payload.toolCallId === "string" ? callArgsById.get(payload.toolCallId) : undefined)
                ?? payload.args ?? payload.input,
              result: payload.result ?? payload.output,
            };
            observedToolCalls.push(record);
            options.onToolCall?.(record);
          }
        },
        providerOptions: { openai: { stream: true } },
      },
    );

    // 消费 fullStream 而不是 textStream：reasoning 模型（如 sensenova-6.8-flash-lite）
    // 会把全部产出放在 reasoning 通道，textStream 只透传 text-delta——推理内容会被
    // 整体丢弃，最终 text 为空并被上游兜底成「我没有生成有效回复。」（隐藏失败）。
    // fullStream 同时暴露 reasoning-delta 与 error part，用于显式归类无产出与流中断。
    const deltas: string[] = [];
    let aggregated = "";
    let sawReasoning = false;
    let observedStreamError: unknown;
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") {
        const delta = part.payload?.text ?? "";
        if (!delta) continue;
        deltas.push(delta);
        aggregated += delta;
        onDelta?.(delta);
        continue;
      }
      // 推理内容不进用户可见流：只记录「模型确实思考过」，供无产出归类与排障。
      if (part.type === "reasoning-delta") {
        sawReasoning = true;
        continue;
      }
      // 流中途 error part：先记录，循环结束后统一转成显式错误态（不等 stream.error 兜底）。
      if (part.type === "error") {
        observedStreamError = (part as { payload?: { error?: unknown } }).payload?.error;
      }
    }
    // 双保险：error part 与 stream.error 任一出现都按中断处理，绝不以静默空回复收尾。
    const failure = streamFailure(stream) ?? streamFailure({ error: observedStreamError });
    if (failure) throw new AgentStreamInterruptedError(failure);
    let text = aggregated || (await stream.text) || "";
    const suspend = deriveSuspendSignalFromToolCalls(observedToolCalls);
    let noOutput: AgentExecutorNoOutput | undefined;
    if (!text && !suspend) {
      // 无可见产出不静默：按是否走过推理通道归类，交给调用方的契约文案显式收尾。
      noOutput = observedToolCalls.length === 0 && sawReasoning ? "reasoning-only" : "empty";
      if (options.noOutputText) text = options.noOutputText;
    }
    const citations = deriveCitationsFromToolCalls(observedToolCalls);
    return {
      text,
      confirmed: deriveConfirmedFromToolCalls(observedToolCalls),
      citations: citations.length ? citations : undefined,
      deltas,
      suspend,
      ...(noOutput ? { noOutput } : {}),
    };
  };
}

export function deriveCitationsFromToolCalls(toolCalls: AiToolCallRecord[]): ResourceCitationDTO[] {
  const byResource = new Map<string, ResourceCitationDTO>();
  for (const call of toolCalls) {
    const result = asRecord(call.result);
    const parsed = ResourceCitationListSchema.safeParse(result?.citations);
    if (!parsed.success) continue;
    for (const citation of parsed.data) {
      if (!byResource.has(citation.resourceId)) {
        byResource.set(citation.resourceId, citation as ResourceCitationDTO);
      }
    }
  }
  return Array.from(byResource.values(), (citation, index) => ({
    ...citation,
    index: index + 1,
  }));
}

export function deriveConfirmedFromToolCalls(toolCalls: AiToolCallRecord[]): SharedConfirmed {
  const confirmed: SharedConfirmed = {};
  for (const call of toolCalls) {
    const result = asRecord(call.result);
    const schemaSummary = SchemaSummarySchema.safeParse(result?.schemaSummary);
    if (schemaSummary.success) {
      confirmed.schemaSummary = schemaSummary.data;
    }

    const intent = readToolIntent(call);
    if (intent?.type === "open-record") {
      confirmed.resolvedRecord = {
        id: intent.recordId,
        label: intent.label ?? intent.recordId,
      };
    }
  }
  return confirmed;
}

export function deriveSuspendSignalFromToolCalls(toolCalls: AiToolCallRecord[]): SubAgentSuspendSignal | undefined {
  for (const call of toolCalls) {
    const intent = readToolIntent(call);
    if (!intent) continue;
    if (intent.type === "ambiguous") {
      return { kind: "ambiguous", candidates: intent.candidates };
    }
    // 空提案不 suspend：无可确认字段时出空卡片等于伪造提案，run 以文本如实收尾。
    if ((intent.type === "row-patch-proposal" || intent.type === "record-write-proposal")
      && (!Array.isArray(intent.proposals) || intent.proposals.length === 0)) {
      continue;
    }
    return { kind: "await-write-confirm", intent };
  }
  return undefined;
}

type StepChunkFields = {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  input?: unknown;
  result?: unknown;
  output?: unknown;
};

/** 归一化 Mastra step chunk：有 payload 取 payload，否则按平铺 part 读。 */
function stepChunkFields(chunk: unknown): StepChunkFields | null {
  const record = asRecord(chunk);
  if (!record) return null;
  return (asRecord(record.payload) ?? record) as StepChunkFields;
}

function readToolIntent(call: AiToolCallRecord): AiStructuredIntent | null {
  const result = asRecord(call.result);
  const intent = asRecord(result?.intent);
  if (!intent || typeof intent.type !== "string") return null;
  return intent as AiStructuredIntent;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function streamFailure(stream: { error?: unknown }): Error | null {
  const err = stream.error;
  if (err == null || err === false) return null;
  if (err instanceof Error) return err;
  if (typeof err === "string" && err.length > 0) return new Error(err);
  const record = asRecord(err);
  if (typeof record?.message === "string" && record.message.length > 0) {
    return new Error(record.message);
  }
  return new Error("LLM stream failed");
}
