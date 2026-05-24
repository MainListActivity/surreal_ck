import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import type { AiStructuredIntent, AiToolCallRecord } from "@surreal-ck/shared";
import { serializeContextForAi } from "@surreal-ck/shared";
import { ROUTER_RUNTIME_KEY, type SharedConfirmed, type SubAgentExecutor, type SubAgentSuspendSignal } from "./router-workflow";

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

    // 把调用者 session 经 RequestContext 透传给 agent 的 tool（tool 用 ROUTER_RUNTIME_KEY 取）。
    const requestContext = new RequestContext();
    requestContext.set(ROUTER_RUNTIME_KEY, { surrealSession });

    const observedToolCalls: AiToolCallRecord[] = [];
    const stream = await agent.stream(
      [{ role: "user", content: prompt }],
      {
        requestContext,
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
            const record: AiToolCallRecord = {
              toolName: tr.toolName,
              args: call?.args ?? tr.args,
              result: tr.result,
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
    const text = aggregated || (await stream.text) || "";
    return {
      text,
      confirmed: deriveConfirmedFromToolCalls(observedToolCalls),
      deltas,
      suspend: deriveSuspendSignalFromToolCalls(observedToolCalls),
    };
  };
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
    return { kind: "await-write-confirm", intent };
  }
  return undefined;
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
