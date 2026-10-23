import { internalScope } from "../../../src/internal-ai/context";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import type {
  AiStructuredIntent,
  AiToolCallRecord,
  AiToolCallSummary,
  ProposalDropRecord,
  ResourceCitationDTO,
} from "@surreal-ck/shared";
import { serializeContextForAi } from "@surreal-ck/shared";
import { ROUTER_RUNTIME_KEY, type SharedConfirmed, type SubAgentExecutor, type SubAgentSuspendSignal } from "./router-workflow";
import { setExecutionContext } from "../execution-context";
import { callerRunDiagnostics } from "../../../src/ai/caller-session";
import { AiRunCancelledError, type RunOpHandle } from "../../../src/ai/run-diagnostics";
import {
  buildSupplementPrompt,
  explainSupplementMiss,
  keepValueMatchedProposals,
  planExplicitEditProposal,
  ROW_PROPOSAL_TOOL,
} from "./row-proposal-supplement";

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
  /**
   * FV06：显式改字段（子任务点名了目标行与写入值）且本轮只做了只读定位、没有提案调用时，
   * 在同一次请求内补一次强制 analyzeRow（maxSteps=1）。缺席时不补调用，行为与历史一致。
   * 判定与保真见 row-proposal-supplement.ts。
   */
  ensureExplicitEditProposal?: boolean;
};

/**
 * 无可见产出的显式归类（仅当最终 text 为空或纯空白且未产生 suspend 提案时上报）：
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

/** 单次 LLM 流的输入：主轮使用全部工具；FV06 补充轮只开放并强制提案工具。 */
type AgentRunInput = {
  prompt: string;
  maxSteps: number;
  toolChoice?: { type: "tool"; toolName: string };
  activeTools?: string[];
};

/** 单次 LLM 流的产出：可见文本、文本增量、是否经过推理通道、本轮工具记录（原始形状）。 */
type AgentRunOutcome = {
  text: string;
  deltas: string[];
  sawReasoning: boolean;
  toolCalls: AiToolCallRecord[];
};

/**
 * 把 Mastra Agent 适配成 SubAgentExecutor。
 * - taskText + shared 序列化为单条 user 消息
 * - 通过 fullStream 收集 text deltas（reasoning 只做归类、不进可见流），
 *   让 router-chat 转推到统一 streamId 上
 * - 启用 ensureExplicitEditProposal 时，显式改字段的只读轮若无提案，同一次请求内补一次强制提案（FV06）
 */
export function makeAgentExecutor(agent: Agent, options: AgentExecutorOptions = {}): SubAgentExecutor {
  return async ({ taskText, shared, surrealSession, onDelta, onToolCall, signal }) => {
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

    // PG-1：tool 阶段 op 从 fullStream 的 tool-call 起算（早于 execute 入口），
    // 覆盖该 agent 的全部 tool；tool-error/tool-result 记终态。
    const diag = callerRunDiagnostics(surrealSession);

    // 单次 LLM 流：主轮与补充轮共用同一套工具记录、文本增量与流失败处理。
    const runOnce = async (run: AgentRunInput): Promise<AgentRunOutcome> => {
      const observed: AiToolCallRecord[] = [];
      const inFlightToolOps = new Map<string, RunOpHandle>();
      const stream = await agent.stream(
        [{ role: "user", content: run.prompt }],
        {
          requestContext,
          abortSignal: signal,
          ...(internalScope() ? { modelSettings: { maxRetries: 0 } } : {}),
          maxSteps: run.maxSteps,
          ...(run.toolChoice ? { toolChoice: run.toolChoice } : {}),
          ...(run.activeTools ? { activeTools: run.activeTools } : {}),
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
              observed.push(record);
              options.onToolCall?.(record);
              onToolCall?.(record);
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
      try {
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
            continue;
          }
          if (diag && part.type === "tool-call") {
            const payload = part.payload as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
            if (typeof payload.toolCallId === "string" && typeof payload.toolName === "string") {
              inFlightToolOps.set(
                payload.toolCallId,
                diag.begin({
                  name: payload.toolName,
                  phase: "tool",
                  argShape: summarizeToolCallForAudit({ toolName: payload.toolName, args: payload.args }).argShape,
                }),
              );
            }
            continue;
          }
          if (diag && (part.type === "tool-result" || part.type === "tool-error")) {
            const payload = part.payload as { toolCallId?: unknown; error?: unknown };
            const op = typeof payload.toolCallId === "string" ? inFlightToolOps.get(payload.toolCallId) : undefined;
            if (op) {
              diag.end(op, part.type === "tool-result" ? "ok" : "failed", payload.error);
              inFlightToolOps.delete(payload.toolCallId as string);
            }
            continue;
          }
        }
      } finally {
        // 流异常/取消收尾时仍在飞的 tool op 记 cancelled——不留永远 in-flight 的幽灵操作。
        if (diag && inFlightToolOps.size > 0) {
          const cancelled = diag.aborted || signal?.aborted === true;
          const cause = cancelled ? new AiRunCancelledError() : { code: "tool-stream-dangling" };
          for (const op of inFlightToolOps.values()) diag.end(op, cancelled ? "cancelled" : "failed", cause);
          inFlightToolOps.clear();
        }
      }
      // 双保险：error part 与 stream.error 任一出现都按中断处理，绝不以静默空回复收尾。
      const failure = streamFailure(stream) ?? streamFailure({ error: observedStreamError });
      if (failure) throw new AgentStreamInterruptedError(failure);
      return {
        text: aggregated || (await stream.text) || "",
        deltas,
        sawReasoning,
        toolCalls: observed,
      };
    };

    const mainRun = await runOnce({ prompt, maxSteps: options.maxSteps ?? 4 });
    const plan = options.ensureExplicitEditProposal
      ? planExplicitEditProposal(taskText, mainRun.toolCalls)
      : { kind: "skip" as const };
    const allDeltas = [...mainRun.deltas];
    let modelText = mainRun.text;
    let reasoningSeen = mainRun.sawReasoning;
    let finalCalls = mainRun.toolCalls;
    // 未挂起时写给用户的明确原因（仅 FV06 启用且判定为显式改字段时产生）。
    let missReason = plan.kind === "blocked" ? plan.reason : undefined;

    if (plan.kind === "supplement" && !signal?.aborted) {
      // 同一次请求内补一次强制提案：maxSteps=1，只开放 analyzeRow，工具选择指向它。
      const supplement = await runOnce({
        prompt: buildSupplementPrompt(prompt, plan),
        maxSteps: 1,
        toolChoice: { type: "tool", toolName: ROW_PROPOSAL_TOOL },
        activeTools: [ROW_PROPOSAL_TOOL],
      });
      allDeltas.push(...supplement.deltas);
      reasoningSeen = reasoningSeen || supplement.sawReasoning;
      modelText = [modelText, supplement.text].filter((part) => part.trim()).join("\n");
      // 建议值保真：只保留与用户指定值逐字一致的建议。派生副本用于挂起与展示，
      // 原始记录已由 onToolCall 上报，审计仍是模型原始输出。
      finalCalls = [
        ...mainRun.toolCalls,
        ...supplement.toolCalls.map((call) => keepValueMatchedProposals(call, plan.value)),
      ];
      missReason = explainSupplementMiss(supplement.toolCalls, plan.value);
    }

    const suspend = deriveSuspendSignalFromToolCalls(finalCalls);
    if (suspend) missReason = undefined;
    let text = modelText;
    let noOutput: AgentExecutorNoOutput | undefined;
    if (!text.trim() && !suspend) {
      // 无可见产出不静默：按是否走过推理通道归类；有明确原因时以原因收尾，否则交给调用方的契约文案。
      noOutput = finalCalls.length === 0 && reasoningSeen ? "reasoning-only" : "empty";
      text = missReason ?? options.noOutputText ?? "";
    } else if (missReason) {
      text = `${text}\n${missReason}`;
    }
    // 全丢弃说明确定性拼接（PG-1 诊断 §4-1）：无论模型是否有可见文本，
    // 只要 suggestions 全被归一化丢弃就给出数量/原因；保留模型原文、不 suspend、不伪造卡。
    const droppedNote = deriveDroppedProposalNote(finalCalls);
    if (droppedNote) text = text ? `${text}\n${droppedNote}` : droppedNote;
    const citations = deriveCitationsFromToolCalls(finalCalls);
    return {
      text,
      confirmed: deriveConfirmedFromToolCalls(finalCalls),
      citations: citations.length ? citations : undefined,
      deltas: allDeltas,
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

/**
 * 可 suspend 的 intent 白名单（PG-1 诊断 §5.4-b navigation 死卡修复）。
 * 只有前端 AiDrawer 能渲染确认卡的类型才允许挂起：
 * ambiguous（候选卡）、非空行分析提案（RowPatchCard）、dashboard-draft（DashboardDraftCard）。
 * 其余 intent（navigation 的 navigate/open-*、resource-draft、rowPatch、legacy dashboardDraft）
 * 前端无确认入口，suspend 会渲染无按钮的"等待确认"死卡并卡住 run——一律跳过，
 * 由 agent 的文本输出如实收尾（navigation agent 指令本就要求先文字说明建议）。
 */
const SUSPENDABLE_INTENT_TYPES = new Set(["ambiguous", "row-patch-proposal", "record-write-proposal", "dashboard-draft"]);

export function deriveSuspendSignalFromToolCalls(toolCalls: AiToolCallRecord[]): SubAgentSuspendSignal | undefined {
  for (const call of toolCalls) {
    const intent = readToolIntent(call);
    if (!intent) continue;
    if (!SUSPENDABLE_INTENT_TYPES.has(intent.type)) continue;
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

/**
 * 工具调用脱敏审计摘要（PG-1 诊断 §4-2：事后可审计"调了什么工具、传了什么 field"）。
 * - argShape：args 顶层 key 名；suggestions/proposals 数组额外提取其中的 field 名；
 * - 不记录任何业务值（suggestedValue、values、recordId 具体值均不进摘要）。
 */
export function summarizeToolCallForAudit(call: AiToolCallRecord): AiToolCallSummary {
  const summary: AiToolCallSummary = { toolName: call.toolName };
  const args = asRecord(call.args);
  if (args) {
    const shape = new Set<string>();
    for (const key of Object.keys(args)) {
      if (key === "suggestions" || key === "proposals") {
        const items = args[key];
        if (Array.isArray(items)) {
          for (const item of items) {
            const field = asRecord(item)?.field;
            if (typeof field === "string") shape.add(`${key}[].field=${field}`);
          }
        } else {
          shape.add(key);
        }
      } else if (key === "values") {
        shape.add("values{keys…}");
      } else {
        shape.add(key);
      }
    }
    if (shape.size > 0) summary.argShape = [...shape];
  }
  const intent = readToolIntent(call);
  if (intent) {
    summary.resultIntent = intent.type;
    if (intent.type === "row-patch-proposal" || intent.type === "record-write-proposal") {
      if (Array.isArray(intent.proposals)) summary.proposalCount = intent.proposals.length;
      if (Array.isArray(intent.dropped)) summary.droppedCount = intent.dropped.length;
    }
  }
  return summary;
}

/**
 * 全丢弃用户可见说明（PG-1 诊断 §4-1：有 suggestions 输入但全被归一化丢弃）。
 * 返回追加到 step 文本的说明，不 suspend、不伪造提案卡。
 * 无丢弃或仍有存活提案时返回 undefined；全丢弃时调用方无条件拼接（含模型已有文本的情形）。
 */
export function deriveDroppedProposalNote(toolCalls: AiToolCallRecord[]): string | undefined {
  let dropped: ProposalDropRecord[] = [];
  let liveProposals = 0;
  let sawProposalIntent = false;
  for (const call of toolCalls) {
    const intent = readToolIntent(call);
    if (!intent) continue;
    if (intent.type !== "row-patch-proposal" && intent.type !== "record-write-proposal") continue;
    sawProposalIntent = true;
    liveProposals += Array.isArray(intent.proposals) ? intent.proposals.length : 0;
    if (Array.isArray(intent.dropped)) {
      for (const entry of intent.dropped) {
        if (entry && typeof entry.field === "string" && typeof entry.reason === "string") {
          dropped.push({ field: entry.field, reason: entry.reason as ProposalDropRecord["reason"] });
        }
      }
    }
  }
  if (!sawProposalIntent || liveProposals > 0 || dropped.length === 0) return undefined;
  const reasonLabel: Record<ProposalDropRecord["reason"], string> = {
    "unknown-field": "未知字段",
    "ambiguous-label": "名称歧义",
    "non-editable": "不可编辑",
  };
  const detail = dropped.map((entry) => `${entry.field}（${reasonLabel[entry.reason] ?? entry.reason}）`).join("、");
  return `模型给出的 ${dropped.length} 条字段建议均无法对应到数据表字段，已忽略：${detail}。请用字段存储名或唯一显示名重试。`;
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
