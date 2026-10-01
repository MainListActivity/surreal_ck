import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { StringRecordId, type Surreal } from "surrealdb";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import type {
  ResearchAuthorization,
  AiMessageChunkEvent,
  AiProgressEvent,
  ResourceCitationDTO,
  AiToolCallRecord,
  AiStructuredIntent,
  CandidateOption,
  ResolvedRecord,
  ResumeDecision,
  WorkflowSuspendedEvent,
} from "@surreal-ck/shared";
import { AiContextSnapshotSchema, ResolvedRecordSchema, ResearchAuthorizationSchema, ResumeDecisionSchema } from "@surreal-ck/shared";
import {
  classifyTask,
  normalizeRouterCategory,
  RouterCategorySchema,
  type RouterCategory,
  type RouterLlmCaller,
  type RouterPlan,
} from "./router-classifier";
import type { DecisionCaller } from "../../decision/model";
import type { ContentResearchWindow } from "../../../src/research/window";

export const ROUTER_WORKFLOW_ID = "routerWorkflow";
export const ROUTER_RUNTIME_KEY = "routerRuntime";
const AMBIGUOUS_CANDIDATES_LIMIT = 20;

/**
 * LCA06：执行 runtime 注入的调用者 content_reader 窗口工厂（可缺省）。
 * 由路由层用调用者 OIDC token 构造闭包，executor 在执行窗口内打开/关闭；
 * 模型与 workflow state 都拿不到 token，也不能自选安全上下文。
 */
export type OpenContentResearchSession = () => Promise<ContentResearchWindow>;

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

export type AuthorizationChangedSuspend = {
  kind: "authorization_changed";
  query: string;
  authorization: ResearchAuthorization;
  resourceIds: string[];
};

export type ResourceCandidatesSuspend = {
  authorization?: ResearchAuthorization;
  kind: "resource-candidates";
  candidates: CandidateOption[];
};

export type ManualResearchSuspend = {
  kind: "manual-research";
  sessionId: string;
  workspaceId: string;
  query: string;
  resourceType: string;
};

export type SubAgentSuspendSignal =
  | AuthorizationChangedSuspend
  | AmbiguousSuspend
  | ResourceCandidatesSuspend
  | ManualResearchSuspend
  | AwaitWriteConfirmSuspend;

export type SubAgentInput = {
  selectedResourceIds?: string[];
  expectedAuthorization?: ResearchAuthorization;
  expectedPlatformVersionIds?: string[];
  acceptAuthorizationChange?: boolean;
  taskText: string;
  shared: SharedWorkflowContext;
  runId?: string;
  /**
   * 调用者 SurrealDB 会话。executor 经 RequestContext 透传给 agent 的 tool，
   * tool 全部用这条连接跑 SurrealQL（写入归因落 $auth）。
   */
  surrealSession?: Surreal;
  /**
   * 流式 delta 实时回调；非流式 executor 可忽略。
   */
  onDelta?: (delta: string) => void;
  /**
   * LCA06：调用者 content_reader 窗口工厂（runtime 注入；缺席 = 本 run 不做平台语料研究）。
   */
  openContentSession?: OpenContentResearchSession;
};

export type SubAgentOutput = {
  researchAuthorization?: ResearchAuthorization;
  text: string;
  confirmed: SharedConfirmed;
  citations?: ResourceCitationDTO[];
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
export type SubAgentExecutors =
  Record<Exclude<RouterCategory, "resource-retrieval">, SubAgentExecutor> &
  Partial<Record<"resource-retrieval", SubAgentExecutor>>;

// ─── 调度器：保留供 011 测试用的纯函数版本（不带 suspend） ────────────────────

export type RouterDispatchInput = {
  plan: RouterPlan;
  shared: SharedWorkflowContext;
  executors: SubAgentExecutors;
};

export type RouterStepResult = {
  researchAuthorization?: ResearchAuthorization;
  selectedResourceIds?: string[];
  category: RouterCategory;
  taskText: string;
  text: string;
  citations?: ResourceCitationDTO[];
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
    // 归一化旧类目（如历史快照中的 claim-analysis）后再查 executor
    const category = normalizeRouterCategory(item.category) ?? item.category;
    const executor = executors[category];
    if (!executor) {
      throw new Error(`router-workflow: 缺少 ${category} executor`);
    }
    const out = await executor({
      taskText: item.taskText,
      shared: { userContext: shared.userContext, confirmed: shared.confirmed },
    });
    mergeConfirmed(shared.confirmed, out.confirmed);
    steps.push({ category, taskText: item.taskText, text: out.text, citations: out.citations });
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

// 持久化快照里的 plan/steps 类目也走同一归一化 schema：旧运行记录中的
// claim-analysis 在 resume 时被读回并归一化为 row-analysis，路由兼容不丢历史。
const RouterCategoryEnum = RouterCategorySchema;

const RouterStepResultSchema = z.object({
  researchAuthorization: ResearchAuthorizationSchema.optional(),
  selectedResourceIds: z.array(z.string()).optional(),
  category: RouterCategoryEnum,
  taskText: z.string(),
  text: z.string(),
  citations: z.array(z.object({
    index: z.number(),
    resourceId: z.string(),
    title: z.string(),
    sourceUrl: z.string().optional(),
    evidence: z.array(z.object({
      order: z.number(),
      text: z.string(),
    })).optional(),
    platformContent: z.object({
      itemId: z.string(),
      versionId: z.string(),
      sourceKey: z.string(),
      versionPublicId: z.string().optional(),
      quoteSha256: z.string().optional(),
      entitlementRevision: z.string().optional(),
      locator: z.object({
        start: z.number(),
        end: z.number(),
        bodyDigest: z.string(),
      }).nullable(),
    }).optional(),
  })).optional(),
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
  userContext: AiContextSnapshotSchema.optional(),
});
/** 运行时已被 schema default 兜底的状态形状（去除可选）。 */
type RouterState = {
  plan: { category: RouterCategory; taskText: string }[];
  cursor: number;
  confirmed: SharedConfirmed;
  steps: RouterStepResult[];
  cancelled: boolean;
  userContext?: AiContextSnapshot;
};

const RouterWorkflowInputSchema = z.object({
  text: z.string(),
});

const RouterWorkflowOutputSchema = z.object({
  steps: z.array(RouterStepResultSchema),
  finalText: z.string(),
});

const SuspendPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authorization_changed"), query: z.string(), authorization: ResearchAuthorizationSchema,
    resourceIds: z.array(z.string()) }),
  z.object({
    kind: z.literal("ambiguous"),
    /** 留存完整候选（可能 > 20）以便 resolve 时按 candidateId 还原 label */
    candidates: z.array(z.object({ id: z.string(), label: z.string() })),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("resource-candidates"),
    authorization: ResearchAuthorizationSchema.optional(),
    candidates: z.array(z.object({
      id: z.string(),
      label: z.string(),
      summary: z.string().optional(),
      score: z.number().optional(),
      resourceType: z.string().optional(),
      sourceUrl: z.string().optional(),
    })),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("manual-research"),
    sessionId: z.string(),
    workspaceId: z.string(),
    query: z.string(),
    resourceType: z.string(),
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
  "row-analysis": "rowAnalysisAgent",
  "resource-retrieval": "resourceAgent",
  chitchat: "chitchatAgent",
};

export type RouterRuntime = {
  /** 仅当前进程窗口的回答；绝不放入 workflow state / RequestContext 快照。 */
  researchOutputs?: Map<number, SubAgentOutput>;
  userContext: AiContextSnapshot;
  /**
   * 调用者的 SurrealDB 会话（已用其 OIDC token 走 admin/participant access SIGNIN 到当前 workspace db）。
   * 所有 tool 经 RequestContext 取这条连接跑 SurrealQL，写入归因落到 $auth；workflow run 结束即丢弃。
   */
  surrealSession: Surreal;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  /** 可选决策模型：意图分类的单意图捷径；缺席时纯 LLM 分类。 */
  decisionModel?: DecisionCaller;
  /** 决策置信度阈值；默认 router-classifier 内 0.75。 */
  jevConfidenceThreshold?: number;
  planOverride?: RouterPlan;
  streamId: string;
  /** 业务侧 runId（可与 Mastra runId 不同）。 */
  runId: string;
  pushChunk?: (e: AiMessageChunkEvent) => void;
  pushProgress?: (e: AiProgressEvent) => void;
  /** 暂停时主进程把 payload 推给 webview。 */
  onSuspend?: (event: WorkflowSuspendedEvent) => void;
  toolCalls?: AiToolCallRecord[];
  answerResourceSelection?: (input: {
    resourceIds: string[];
    taskText: string;
    userContext: AiContextSnapshot;
  }) => Promise<{ text: string; citations?: ResourceCitationDTO[] }>;
  /** LCA06：调用者 content_reader 窗口工厂；缺席时 resource-retrieval 不做平台语料研究。 */
  openContentSession?: OpenContentResearchSession;
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

/** 研究快照仅保留查询、选择与允许存储的引用元数据。 */
function persistedResearchStep(item: { category: RouterCategory; taskText: string }, out: SubAgentOutput, selectedResourceIds?: string[]): RouterStepResult {
  return { ...item, text: "", researchAuthorization: out.researchAuthorization, selectedResourceIds,
    citations: out.citations?.map(c => ({ ...c, evidence: [] })) };
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
      const plan = runtime.planOverride ?? await classifyTask({
        text: inputData.text,
        llmCaller: runtime.llmCaller,
        decisionModel: runtime.decisionModel,
        userContext: runtime.userContext,
        confidenceThreshold: runtime.jevConfidenceThreshold,
      });
      await setState({
        plan,
        cursor: 0,
        confirmed: {},
        steps: [],
        cancelled: false,
        userContext: runtime.userContext,
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
        let resumedStep: RouterStepResult | null = null;

        // 持久化快照可能携带旧类目名；这里统一归一化后再读 executor/写 steps。
        const planItemAt = (index: number) => {
          const item = state.plan[index];
          return item
            ? { category: normalizeRouterCategory(item.category) ?? item.category, taskText: item.taskText }
            : undefined;
        };

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
        } else if (runtime.openContentSession && (sus?.kind === "resource-candidates" || sus?.kind === "authorization_changed" || sus?.kind === "manual-research")) {
          const item = state.plan[state.cursor]!;
          const selected = decision.kind === "resource-candidates-chosen" || decision.kind === "manual-research-completed" ? decision.resourceIds
            : sus.kind === "authorization_changed" && decision.kind === "research-continue-current" ? sus.resourceIds : [];
          if (sus.kind === "resource-candidates" && selected.some(id => !sus.candidates.some(c => c.id === id))) {
            runtime.onSuspend?.({ kind: "authorization_changed", runId: runtime.runId, query: item.taskText,
              message: "所选候选不属于当前运行，请重新检索。" });
            await suspend({ kind: "authorization_changed", query: item.taskText, resourceIds: [],
              authorization: sus.authorization ?? { workspaceId: "", kind: "unavailable" } });
            return { plan: inputData.plan };
          }
          const allowed = (sus.kind === "resource-candidates" && ["resource-candidates-chosen", "resource-candidates-manual-research"].includes(decision.kind))
            || (sus.kind === "authorization_changed" && ["research-retry", "research-continue-current"].includes(decision.kind))
            || (sus.kind === "manual-research" && decision.kind === "manual-research-completed");
          if (!allowed) throw new Error("无效的研究恢复动作");
          if (sus.kind === "manual-research") {
            const result = await runtime.surrealSession.query<[Array<{ created_resources: unknown[] }>]>(
              `SELECT created_resources FROM research_session WHERE id = $id AND originating_run_id = $runId
                AND created_by = fn::current_user();`, { id: new StringRecordId(sus.sessionId), runId: runtime.runId });
            const allowedIds = new Set((result[0]?.[0]?.created_resources ?? []).map(String));
            if (selected.some(id => !allowedIds.has(id))) throw new Error("人工检索材料不属于当前运行");
          }
          const out = await runtime.executors["resource-retrieval"]!({ taskText: item.taskText,
            shared: { userContext: state.userContext ?? runtime.userContext, confirmed: state.confirmed },
            surrealSession: runtime.surrealSession, openContentSession: runtime.openContentSession, runId: runtime.runId,
            selectedResourceIds: selected, expectedAuthorization: sus.kind === "manual-research" ? undefined : sus.authorization,
            acceptAuthorizationChange: sus.kind === "authorization_changed" });
          if (out.suspend) {
            if (out.suspend.kind === "authorization_changed") {
              runtime.onSuspend?.({ kind: "authorization_changed", runId: runtime.runId, query: item.taskText,
                message: "授权或材料可用性已变化。请重新检索，或继续使用当前合法材料。" });
              await suspend(out.suspend);
            } else if (out.suspend.kind === "resource-candidates") {
              runtime.onSuspend?.({ kind: "resource-candidates", runId: runtime.runId, candidates: out.suspend.candidates });
              await suspend(out.suspend);
            } else throw new Error("无法恢复研究步骤");
            return { plan: inputData.plan };
          }
          (runtime.researchOutputs ??= new Map()).set(state.cursor, out);
          resumedStep = persistedResearchStep(item, out, selected);
        } else if (decision.kind === "resource-candidates-chosen" && sus?.kind === "resource-candidates") {
          if (decision.resourceIds.some(id => !sus.candidates.some(c => c.id === id))) throw new Error("所选候选不属于当前运行");
          const cursor = state.cursor;
          const planItem = planItemAt(cursor);
          const answer = await runtime.answerResourceSelection?.({
            resourceIds: decision.resourceIds,
            taskText: planItem?.taskText ?? "",
            userContext: state.userContext ?? runtime.userContext,
          });
          resumedStep = {
            category: planItem!.category,
            taskText: planItem!.taskText,
            text: answer?.text ?? "已选择资源，但当前运行时未配置资源回答生成器。",
            citations: answer?.citations,
          };
        } else if (decision.kind === "resource-candidates-manual-research" && sus?.kind === "resource-candidates") {
          const cursor = state.cursor;
          const planItem = planItemAt(cursor);
          resumedStep = {
            category: planItem!.category,
            taskText: planItem!.taskText,
            text: "已转入人工检索流程。",
          };
        } else if (decision.kind === "manual-research-completed" && sus?.kind === "manual-research") {
          const cursor = state.cursor;
          const planItem = planItemAt(cursor);
          const answer = await runtime.answerResourceSelection?.({
            resourceIds: decision.resourceIds,
            taskText: planItem?.taskText ?? sus.query,
            userContext: state.userContext ?? runtime.userContext,
          });
          resumedStep = {
            category: planItem!.category,
            taskText: planItem!.taskText,
            text: answer?.text ?? "已完成人工检索，但当前运行时未配置资源回答生成器。",
            citations: answer?.citations,
          };
        }
        // write-confirmed：不写入 confirmed（写动作由 ai.executeAction 在 RPC 层做）

        // 写入第 cursor 步的结果记录（如果不是取消）
        const cursor = state.cursor;
        const planItem = planItemAt(cursor);
        const newSteps = cancelled
          ? state.steps
          : resumedStep
            ? [...state.steps, resumedStep]
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
      const rawPlanItem = state.plan[cursor];
      if (!rawPlanItem) {
        return { plan: inputData.plan };
      }
      // 持久化快照可能携带旧类目名（claim-analysis）；归一化后再查 executor
      const planItem = {
        category: normalizeRouterCategory(rawPlanItem.category) ?? rawPlanItem.category,
        taskText: rawPlanItem.taskText,
      };

      runtime.pushProgress?.({
        kind: "agent-step",
        runId: runtime.runId,
        agentName: CATEGORY_TO_AGENT_NAME[planItem.category],
        taskText: planItem.taskText,
      });

      const executor = runtime.executors[planItem.category];
      if (!executor) {
        throw new Error(`router-workflow: 缺少 ${planItem.category} executor`);
      }
      const userContext = state.userContext ?? runtime.userContext;
      const onDelta = (d: string) => {
        if (!d) return;
        runtime.pushChunk?.({ streamId: runtime.streamId, type: "delta", text: d });
      };

      const out = await executor({
        taskText: planItem.taskText,
        shared: {
          userContext,
          confirmed: state.confirmed,
        },
        runId: runtime.runId,
        surrealSession: runtime.surrealSession,
        onDelta,
        openContentSession: runtime.openContentSession,
      });

      // 非流式 executor 的 deltas 补播
      if (!out.deltas?.length && out.text) {
        // text 已通过返回值带回，这里不重复推
      } else if (out.deltas?.length) {
        for (const d of out.deltas) {
          if (d) runtime.pushChunk?.({ streamId: runtime.streamId, type: "delta", text: d });
        }
      }

      if (out.researchAuthorization) (runtime.researchOutputs ??= new Map()).set(cursor, out);
      if (out.suspend) {
        const confirmedAtSuspend: SharedConfirmed = { ...state.confirmed };
        mergeConfirmed(confirmedAtSuspend, out.confirmed);
        await setState({
          ...state,
          confirmed: confirmedAtSuspend,
          userContext,
        });

        if (out.suspend.kind === "authorization_changed") {
          runtime.onSuspend?.({ kind: "authorization_changed", runId: runtime.runId, query: out.suspend.query,
            message: "授权已变化。请重新检索，或继续使用当前合法材料。" });
          await suspend(out.suspend);
          return { plan: inputData.plan };
        }
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
        if (out.suspend.kind === "resource-candidates") {
          const all = out.suspend.candidates;
          const exposed = all.slice(0, AMBIGUOUS_CANDIDATES_LIMIT);
          const truncated = all.length > AMBIGUOUS_CANDIDATES_LIMIT;
          runtime.onSuspend?.({
            kind: "resource-candidates",
            runId: runtime.runId,
            candidates: exposed,
            truncated,
          });
          await suspend({ kind: "resource-candidates", candidates: all, truncated, authorization: out.suspend.authorization });
          return { plan: inputData.plan };
        }
        if (out.suspend.kind === "manual-research") {
          runtime.onSuspend?.({
            kind: "manual-research",
            runId: runtime.runId,
            sessionId: out.suspend.sessionId,
            workspaceId: out.suspend.workspaceId,
            query: out.suspend.query,
            resourceType: out.suspend.resourceType,
          });
          await suspend({
            kind: "manual-research",
            sessionId: out.suspend.sessionId,
            workspaceId: out.suspend.workspaceId,
            query: out.suspend.query,
            resourceType: out.suspend.resourceType,
          });
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
        userContext,
        steps: [
          ...state.steps,
          out.researchAuthorization ? persistedResearchStep(planItem, out) : { category: planItem.category, taskText: planItem.taskText, text: out.text, citations: out.citations },
        ],
        cursor: cursor + 1,
      });
      return { plan: inputData.plan };
    },
  });

  // ── finalizeStep：聚合最终输出
  const finalizeStep = createStep({
    id: "finalize",
    resumeSchema: z.object({ decision: ResumeDecisionSchema }),
    suspendSchema: SuspendPayloadSchema,
    inputSchema: z.object({ plan: z.array(RouterPlanItemSchema) }),
    outputSchema: RouterWorkflowOutputSchema,
    stateSchema: RouterStateSchema,
    execute: async (ctx) => {
      const { requestContext } = ctx;
      const state = ctx.state as RouterState;
      const runtime = getRuntime(requestContext);
      const userContext = state.userContext ?? runtime.userContext;
      const currentSteps: RouterStepResult[] = [];
      for (const [index, step] of state.steps.entries()) {
        if (!step.researchAuthorization) { currentSteps.push(step); continue; }
        let out = runtime.researchOutputs?.get(index);
        if (!out || (out.researchAuthorization?.leaseEndSeconds ?? Infinity) <= Date.now() / 1000) {
          out = await runtime.executors["resource-retrieval"]!({ taskText: step.taskText,
            shared: { userContext, confirmed: state.confirmed }, surrealSession: runtime.surrealSession,
            openContentSession: runtime.openContentSession, selectedResourceIds: step.selectedResourceIds,
            expectedAuthorization: step.researchAuthorization,
            expectedPlatformVersionIds: step.citations?.flatMap(c => c.platformContent?.versionPublicId ? [c.platformContent.versionPublicId] : []),
            acceptAuthorizationChange: ctx.resumeData?.decision.kind === "research-retry" || ctx.resumeData?.decision.kind === "research-continue-current" });
          if (out.suspend) {
            runtime.onSuspend?.({ kind: "authorization_changed", runId: runtime.runId, query: step.taskText,
              message: "之前的研究授权或材料已变化。请重新检索或使用当前合法材料。" });
            await ctx.suspend({ kind: "authorization_changed", query: step.taskText,
              authorization: out.researchAuthorization ?? step.researchAuthorization, resourceIds: step.selectedResourceIds ?? [] });
            return { steps: state.steps, finalText: "" };
          }
        }
        currentSteps.push({ ...step, text: out.text, citations: out.citations });
      }
      const finalText = currentSteps.map((s) => s.text).filter(Boolean).join("\n\n");
      const citations = currentSteps.flatMap((s) => s.citations ?? []);
      runtime.pushChunk?.({
        streamId: runtime.streamId,
        type: "done",
        message: {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: finalText || "我没有生成有效回复。",
          createdAt: new Date().toISOString(),
          context: userContext,
          citations: citations.length ? citations : undefined,
        },
        toolCalls: runtime.toolCalls ?? [],
      });
      return { steps: state.steps, finalText: state.steps.some(s => s.researchAuthorization) ? "研究结果需在新的授权窗口重新读取。" : finalText };
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
