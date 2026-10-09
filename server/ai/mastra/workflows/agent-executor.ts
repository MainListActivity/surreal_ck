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
};

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
 * - 通过 textStream 收集 deltas，让 router-chat 转推到统一 streamId 上
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

    const deltas: string[] = [];
    let aggregated = "";
    for await (const delta of stream.textStream) {
      if (!delta) continue;
      deltas.push(delta);
      aggregated += delta;
      onDelta?.(delta);
    }
    const failure = streamFailure(stream);
    if (failure) throw failure;
    const text = aggregated || (await stream.text) || "";
    const citations = deriveCitationsFromToolCalls(observedToolCalls);
    return {
      text,
      confirmed: deriveConfirmedFromToolCalls(observedToolCalls),
      citations: citations.length ? citations : undefined,
      deltas,
      suspend: deriveSuspendSignalFromToolCalls(observedToolCalls),
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
