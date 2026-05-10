import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { AiContextSnapshot } from "../../../../shared/ai-context";
import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  AiStructuredIntent,
  CandidateOption,
  ResolvedRecord,
  ResumeDecision,
  WorkflowSuspendedEvent,
} from "../../../../shared/rpc.types";
import { ResolvedRecordSchema } from "../../../../shared/rpc.types";
import { classifyTask, type RouterCategory, type RouterLlmCaller, type RouterPlan } from "./router-classifier";

export const ROUTER_WORKFLOW_ID = "routerWorkflow";
export const ROUTER_RUNTIME_KEY = "routerRuntime";
export const AMBIGUOUS_CANDIDATES_LIMIT = 20;

// ─── 共享 context 协议 ────────────────────────────────────────────────────────

export type SharedConfirmed = {
  resolvedRecord?: ResolvedRecord;
  schemaSummary?: { tables: string[]; fieldsByTable: Record<string, string[]> };
};

const CONFIRMED_KEYS = ["resolvedRecord", "schemaSummary"] as const satisfies readonly (keyof SharedConfirmed)[];

export type SharedWorkflowContext = {
  /** 用户上下文，workflow 全程视为只读快照（深拷贝以杜绝被子 agent 污染） */
  userContext: AiContextSnapshot;
  /** 跨步骤已确认产出，每个子 agent 完成后由调度器收集 */
  confirmed: SharedConfirmed;
};

// ─── 子 agent 执行器接口 ───────────────────────────────────────────────────────

export type AmbiguousSuspend = {
  kind: "ambiguous";
  candidates: CandidateOption[];
};

export type AwaitWriteConfirmSuspend = {
  kind: "await-write-confirm";
  intent: AiStructuredIntent;
};

export type SubAgentSuspendSignal = AmbiguousSuspend | AwaitWriteConfirmSuspend;

export type SubAgentInput = {
  taskText: string;
  shared: SharedWorkflowContext;
  /**
   * 流式 delta 实时回调；非流式 executor 可忽略。
   */
  onDelta?: (delta: string) => void;
};

export type SubAgentOutput = {
  text: string;
  confirmed: SharedConfirmed;
  /** 可选：流式片段。 */
  deltas?: string[];
  /**
   * 可选：要求 workflow 在该步骤暂停。
   * - ambiguous：搜索结果有多个候选，需要用户选择
   * - await-write-confirm：本步是写操作，需要前端确认
   */
  suspend?: SubAgentSuspendSignal;
};

export type SubAgentExecutor = (input: SubAgentInput) => Promise<SubAgentOutput>;
export type SubAgentExecutors = Record<RouterCategory, SubAgentExecutor>;

// ─── 调度器：保留供 011 测试用的纯函数版本（不带 suspend） ────────────────────

export type RouterDispatchInput = {
  plan: RouterPlan;
  shared: SharedWorkflowContext;
  executors: SubAgentExecutors;
};

export type RouterStepResult = {
  category: RouterCategory;
  taskText: string;
  text: string;
};

export type RouterDispatchResult = {
  steps: RouterStepResult[];
  shared: SharedWorkflowContext;
};

export async function runRouterDispatch(input: RouterDispatchInput): Promise<RouterDispatchResult> {
  const { plan, executors } = input;
  const frozenUserContext = JSON.parse(JSON.stringify(input.shared.userContext)) as AiContextSnapshot;
  const shared: SharedWorkflowContext = {
    userContext: frozenUserContext,
    confirmed: { ...input.shared.confirmed },
  };

  const steps: RouterStepResult[] = [];
  for (const item of plan) {
    const executor = executors[item.category];
    const out = await executor({
      taskText: item.taskText,
      shared: { userContext: shared.userContext, confirmed: shared.confirmed },
    });
    mergeConfirmed(shared.confirmed, out.confirmed);
    steps.push({ category: item.category, taskText: item.taskText, text: out.text });
  }

  shared.userContext = JSON.parse(JSON.stringify(frozenUserContext)) as AiContextSnapshot;
  return { steps, shared };
}

function mergeConfirmed(target: SharedConfirmed, source: SharedConfirmed): void {
  for (const key of CONFIRMED_KEYS) {
    const v = source[key];
    if (v !== undefined) {
      // @ts-expect-error 索引签名在白名单约束下安全
      target[key] = v;
    }
  }
}

// ─── routeAndDispatch（非 suspend 链路） ─────────────────────────────────────

export type RouteAndDispatchInput = {
  text: string;
  shared: SharedWorkflowContext;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
};

export type RouteAndDispatchResult = RouterDispatchResult & {
  plan: RouterPlan;
};

export async function routeAndDispatch(input: RouteAndDispatchInput): Promise<RouteAndDispatchResult> {
  const plan = await classifyTask({ text: input.text, llmCaller: input.llmCaller });
  const dispatched = await runRouterDispatch({
    plan,
    shared: input.shared,
    executors: input.executors,
  });
  return { ...dispatched, plan };
}

// ─── Mastra createWorkflow 包装（含 suspend/resume） ─────────────────────────

const RouterCategoryEnum = z.enum(["navigation", "dashboard", "claim-analysis", "chitchat"]);

const RouterStepResultSchema = z.object({
  category: RouterCategoryEnum,
  taskText: z.string(),
  text: z.string(),
});

const RouterPlanItemSchema = z.object({ category: RouterCategoryEnum, taskText: z.string() });

const SharedConfirmedSchema = z.object({
  resolvedRecord: ResolvedRecordSchema.optional(),
  schemaSummary: z
    .object({
      tables: z.array(z.string()),
      fieldsByTable: z.record(z.string(), z.array(z.string())),
    })
    .optional(),
});

const RouterStateSchema = z.object({
  plan: z.array(RouterPlanItemSchema).default([]),
  cursor: z.number().int().nonnegative().default(0),
  confirmed: SharedConfirmedSchema.default({}),
  steps: z.array(RouterStepResultSchema).default([]),
  cancelled: z.boolean().default(false),
});
/** 运行时已被 schema default 兜底的状态形状（去除可选）。 */
type RouterState = {
  plan: { category: RouterCategory; taskText: string }[];
  cursor: number;
  confirmed: SharedConfirmed;
  steps: RouterStepResult[];
  cancelled: boolean;
};

const RouterWorkflowInputSchema = z.object({
  text: z.string(),
});

const RouterWorkflowOutputSchema = z.object({
  steps: z.array(RouterStepResultSchema),
  finalText: z.string(),
});

const ResumeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate-chosen"), candidateId: z.string().min(1) }),
  z.object({ kind: z.literal("candidate-cancelled") }),
  z.object({ kind: z.literal("write-confirmed") }),
  z.object({ kind: z.literal("write-rejected") }),
]);

const SuspendPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ambiguous"),
    /** 留存完整候选（可能 > 20）以便 resolve 时按 candidateId 还原 label */
    candidates: z.array(z.object({ id: z.string(), label: z.string() })),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("await-write-confirm"),
    /** 用 unknown 容纳 AiStructuredIntent；运行时由 caller 校验 */
    intent: z.unknown(),
  }),
]);

const CATEGORY_TO_AGENT_NAME: Record<RouterCategory, string> = {
  navigation: "navigationAgent",
  dashboard: "dashboardAgent",
  "claim-analysis": "claimAnalysisAgent",
  chitchat: "chitchatAgent",
};

export type RouterRuntime = {
  userContext: AiContextSnapshot;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  streamId: string;
  /** 业务侧 runId（可与 Mastra runId 不同）。 */
  runId: string;
  pushChunk?: (e: AiMessageChunkEvent) => void;
  pushProgress?: (e: AiProgressEvent) => void;
  /** 暂停时主进程把 payload 推给 webview。 */
  onSuspend?: (event: WorkflowSuspendedEvent) => void;
};

function getRuntime(requestContext: { get(key: string): unknown }): RouterRuntime {
  const runtime = requestContext.get(ROUTER_RUNTIME_KEY) as RouterRuntime | undefined;
  if (!runtime) {
    throw new Error(
      `router-workflow: RequestContext 缺少 "${ROUTER_RUNTIME_KEY}"`,
    );
  }
  return runtime;
}

export function createRouterWorkflow() {
  // ── classifyStep：text → { plan }
  const classifyStep = createStep({
    id: "classify",
    inputSchema: RouterWorkflowInputSchema,
    outputSchema: z.object({ plan: z.array(RouterPlanItemSchema) }),
    stateSchema: RouterStateSchema,
    execute: async ({ inputData, requestContext, setState }) => {
      const runtime = getRuntime(requestContext);
      runtime.pushProgress?.({ kind: "routing", runId: runtime.runId });
      const plan = await classifyTask({ text: inputData.text, llmCaller: runtime.llmCaller });
      await setState({
        plan,
        cursor: 0,
        confirmed: {},
        steps: [],
        cancelled: false,
      });
      return { plan };
    },
  });

  // ── executeStep：dountil 循环体；每次处理 plan[cursor]
  const executeStep = createStep({
    id: "execute-one",
    inputSchema: z.object({ plan: z.array(RouterPlanItemSchema) }),
    outputSchema: z.object({ plan: z.array(RouterPlanItemSchema) }),
    stateSchema: RouterStateSchema,
    resumeSchema: z.object({ decision: ResumeDecisionSchema }),
    suspendSchema: SuspendPayloadSchema,
    execute: async (ctx) => {
      const { inputData, requestContext, setState, resumeData, suspendData, suspend } = ctx;
      const state = ctx.state as RouterState;
      const runtime = getRuntime(requestContext);

      // —— Resume 分支：消化用户决策 ——
      if (resumeData) {
        const decision = resumeData.decision as ResumeDecision;
        const sus = suspendData as z.infer<typeof SuspendPayloadSchema> | undefined;

        let nextConfirmed: SharedConfirmed = { ...state.confirmed };
        let cancelled = false;

        if (decision.kind === "candidate-cancelled" || decision.kind === "write-rejected") {
          cancelled = true;
        } else if (decision.kind === "candidate-chosen" && sus?.kind === "ambiguous") {
          const chosen = sus.candidates.find((c) => c.id === decision.candidateId);
          const parsed = chosen ? ResolvedRecordSchema.safeParse(chosen) : null;
          if (parsed?.success) {
            nextConfirmed = { ...nextConfirmed, resolvedRecord: parsed.data };
          } else {
            cancelled = true;
          }
        }
        // write-confirmed：不写入 confirmed（写动作由 ai.executeAction 在 RPC 层做）

        // 写入第 cursor 步的结果记录（如果不是取消）
        const cursor = state.cursor;
        const planItem = state.plan[cursor];
        const newSteps = cancelled
          ? state.steps
          : [
              ...state.steps,
              {
                category: planItem!.category,
                taskText: planItem!.taskText,
                text: cancelled ? "" : "(已确认)",
              },
            ];

        await setState({
          ...state,
          confirmed: nextConfirmed,
          steps: newSteps,
          cursor: cursor + 1,
          cancelled,
        });
        return { plan: inputData.plan };
      }

      // —— 正常分支：跑下一步 executor ——
      const cursor = state.cursor;
      const planItem = state.plan[cursor];
      if (!planItem) {
        return { plan: inputData.plan };
      }

      runtime.pushProgress?.({
        kind: "agent-step",
        runId: runtime.runId,
        agentName: CATEGORY_TO_AGENT_NAME[planItem.category],
        taskText: planItem.taskText,
      });

      const executor = runtime.executors[planItem.category];
      const onDelta = (d: string) => {
        if (!d) return;
        runtime.pushChunk?.({ streamId: runtime.streamId, type: "delta", text: d });
      };

      const out = await executor({
        taskText: planItem.taskText,
        shared: {
          userContext: runtime.userContext,
          confirmed: state.confirmed,
        },
        onDelta,
      });

      // 非流式 executor 的 deltas 补播
      if (!out.deltas?.length && out.text) {
        // text 已通过返回值带回，这里不重复推
      } else if (out.deltas?.length) {
        for (const d of out.deltas) {
          if (d) runtime.pushChunk?.({ streamId: runtime.streamId, type: "delta", text: d });
        }
      }

      if (out.suspend) {
        if (out.suspend.kind === "ambiguous") {
          const all = out.suspend.candidates;
          const exposed = all.slice(0, AMBIGUOUS_CANDIDATES_LIMIT);
          const truncated = all.length > AMBIGUOUS_CANDIDATES_LIMIT;
          runtime.onSuspend?.({
            kind: "ambiguous-candidates",
            runId: runtime.runId,
            candidates: exposed,
            truncated,
          });
          await suspend({ kind: "ambiguous", candidates: all, truncated });
          return { plan: inputData.plan };
        }
        if (out.suspend.kind === "await-write-confirm") {
          runtime.onSuspend?.({
            kind: "await-write-confirm",
            runId: runtime.runId,
            intent: out.suspend.intent,
          });
          await suspend({ kind: "await-write-confirm", intent: out.suspend.intent });
          return { plan: inputData.plan };
        }
      }

      // 非 suspend 的子 agent：合并 confirmed 后推进 cursor
      const merged: SharedConfirmed = { ...state.confirmed };
      mergeConfirmed(merged, out.confirmed);
      await setState({
        ...state,
        confirmed: merged,
        steps: [
          ...state.steps,
          { category: planItem.category, taskText: planItem.taskText, text: out.text },
        ],
        cursor: cursor + 1,
      });
      return { plan: inputData.plan };
    },
  });

  // ── finalizeStep：聚合最终输出
  const finalizeStep = createStep({
    id: "finalize",
    inputSchema: z.object({ plan: z.array(RouterPlanItemSchema) }),
    outputSchema: RouterWorkflowOutputSchema,
    stateSchema: RouterStateSchema,
    execute: async (ctx) => {
      const { requestContext } = ctx;
      const state = ctx.state as RouterState;
      const runtime = getRuntime(requestContext);
      const finalText = state.steps.map((s) => s.text).filter(Boolean).join("\n\n");
      runtime.pushChunk?.({
        streamId: runtime.streamId,
        type: "done",
        toolCalls: [],
        message: {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: finalText || "我没有生成有效回复。",
          createdAt: new Date().toISOString(),
          context: runtime.userContext,
        },
      });
      return { steps: state.steps, finalText };
    },
  });

  return createWorkflow({
    id: ROUTER_WORKFLOW_ID,
    inputSchema: RouterWorkflowInputSchema,
    outputSchema: RouterWorkflowOutputSchema,
    stateSchema: RouterStateSchema,
  })
    .then(classifyStep)
    .dountil(executeStep, async (ctx) => {
      const state = (ctx as unknown as { state: RouterState }).state;
      return state.cancelled || state.cursor >= state.plan.length;
    })
    .then(finalizeStep)
    .commit();
}
