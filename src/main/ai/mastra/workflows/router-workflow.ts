import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { AiContextSnapshot } from "../../../../shared/ai-context";
import type { AiMessageChunkEvent, AiProgressEvent } from "../../../../shared/rpc.types";
import { classifyTask, type RouterCategory, type RouterLlmCaller, type RouterPlan } from "./router-classifier";

export const ROUTER_WORKFLOW_ID = "routerWorkflow";
export const ROUTER_RUNTIME_KEY = "routerRuntime";

// ─── 共享 context 协议 ────────────────────────────────────────────────────────

export type SharedConfirmed = {
  resolvedRecord?: { id: string; label: string };
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

export type SubAgentInput = {
  taskText: string;
  shared: SharedWorkflowContext;
  /**
   * 可选：流式 delta 实时回调。executor 一旦收到 LLM textStream 的 chunk 就调用，
   * 让上层 router-workflow 当场把 delta 推给 streamId，而不是等 executor 整体结束才补播。
   * 非流式 executor 可以忽略本回调，由 router-workflow 退化为读取返回值里的 `deltas` / `text`。
   */
  onDelta?: (delta: string) => void;
};

export type SubAgentOutput = {
  text: string;
  confirmed: SharedConfirmed;
  /** 可选：子 agent 内部的流式片段。runRouterChat 会按顺序往同一 streamId 推 delta；不提供时退化为整段 text 一次性 done。 */
  deltas?: string[];
};

export type SubAgentExecutor = (input: SubAgentInput) => Promise<SubAgentOutput>;

export type SubAgentExecutors = Record<RouterCategory, SubAgentExecutor>;

// ─── 调度器（router workflow 的纯逻辑核心，便于单测） ──────────────────────────

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

  // userContext 深拷贝，避免子 agent 修改原快照影响后续步骤或调用方
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
      // 给子 agent 的是一个引用：它能读到 confirmed，但不应改 userContext
      shared: { userContext: shared.userContext, confirmed: shared.confirmed },
    });
    // 只合并白名单内的 confirmed 字段，其它字段不进 shared.confirmed
    for (const key of CONFIRMED_KEYS) {
      const v = out.confirmed[key];
      if (v !== undefined) {
        // @ts-expect-error 索引签名在白名单约束下安全
        shared.confirmed[key] = v;
      }
    }
    steps.push({ category: item.category, taskText: item.taskText, text: out.text });
  }

  // 把 userContext 回写为深拷贝快照（防止 executor 改了引用对外可见）
  shared.userContext = JSON.parse(JSON.stringify(frozenUserContext)) as AiContextSnapshot;

  return { steps, shared };
}

// ─── 端到端入口：用户消息 → 分类 → 调度 ───────────────────────────────────────

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

// ─── Mastra createWorkflow 包装 ──────────────────────────────────────────────

const RouterStepResultSchema = z.object({
  category: z.enum(["navigation", "dashboard", "claim-analysis", "chitchat"]),
  taskText: z.string(),
  text: z.string(),
});

const RouterWorkflowInputSchema = z.object({
  text: z.string(),
});

const RouterWorkflowOutputSchema = z.object({
  steps: z.array(RouterStepResultSchema),
  finalText: z.string(),
});

const CATEGORY_TO_AGENT_NAME: Record<RouterCategory, string> = {
  navigation: "navigationAgent",
  dashboard: "dashboardAgent",
  "claim-analysis": "claimAnalysisAgent",
  chitchat: "chitchatAgent",
};

/**
 * RouterRuntime 是 step.execute 通过 RequestContext 取到的运行时上下文。
 * 由调用方（router-chat / ai-chat）每次启动 workflow 时构造并注入，让
 * workflow 实例本身保持无状态、可静态注册到 new Mastra({ workflows })。
 */
export type RouterRuntime = {
  userContext: AiContextSnapshot;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  streamId: string;
  /** runId：调用方 RPC 已经分配的 runId；这里仅用于推 progress 事件，不影响 Mastra 内部 run id */
  runId: string;
  pushChunk?: (e: AiMessageChunkEvent) => void;
  pushProgress?: (e: AiProgressEvent) => void;
};

/**
 * createRouterWorkflow 返回一个 Mastra workflow。
 * V1 单步包整个 routeAndDispatch；issue 012 会按子 agent 拆成多个 step 以支持 ambiguous suspend/resume。
 *
 * 运行时（executors / llmCaller / userContext / streamId / runId / 推送回调）通过 RequestContext
 * 注入，workflow 实例本身可复用，并由 Mastra 引擎驱动 storage 写入 mastra_workflow_run。
 */
export function createRouterWorkflow() {
  const dispatchStep = createStep({
    id: "route-and-dispatch",
    inputSchema: RouterWorkflowInputSchema,
    outputSchema: RouterWorkflowOutputSchema,
    execute: async ({ inputData, requestContext }) => {
      const runtime = requestContext.get(ROUTER_RUNTIME_KEY) as RouterRuntime | undefined;
      if (!runtime) {
        throw new Error(
          `router-workflow: RequestContext 缺少 "${ROUTER_RUNTIME_KEY}"，需调用方通过 createRunAsync().start({ requestContext }) 注入`,
        );
      }

      const { streamId, runId, executors, llmCaller, pushChunk, pushProgress } = runtime;

      pushProgress?.({ kind: "routing", runId });
      const plan = await classifyTask({ text: inputData.text, llmCaller });

      const wrapped: SubAgentExecutors = {
        navigation: makeWrapped("navigation", executors.navigation),
        dashboard: makeWrapped("dashboard", executors.dashboard),
        "claim-analysis": makeWrapped("claim-analysis", executors["claim-analysis"]),
        chitchat: makeWrapped("chitchat", executors.chitchat),
      };
      function makeWrapped(category: RouterCategory, real: SubAgentExecutor): SubAgentExecutor {
        return async (args) => {
          pushProgress?.({
            kind: "agent-step",
            runId,
            agentName: CATEGORY_TO_AGENT_NAME[category],
            taskText: args.taskText,
          });

          // 注入 onDelta 让 executor 在收到 LLM stream chunk 的瞬间直接推 delta，
          // 而不是等 executor 整体结束再补播。streamedAny 用于区分流式 / 非流式 executor。
          let streamedAny = false;
          const onDelta = (d: string) => {
            if (!d) return;
            streamedAny = true;
            pushChunk?.({ streamId, type: "delta", text: d });
          };

          const out = await real({ ...args, onDelta });

          // 非流式 executor（没用 onDelta 的，例如纯函数测试桩）：用返回值里的 deltas/text 一次性补播
          if (!streamedAny) {
            const deltas = out.deltas ?? (out.text ? [out.text] : []);
            for (const d of deltas) {
              if (!d) continue;
              pushChunk?.({ streamId, type: "delta", text: d });
            }
          }
          return out;
        };
      }

      const dispatched = await runRouterDispatch({
        plan,
        shared: { userContext: runtime.userContext, confirmed: {} },
        executors: wrapped,
      });

      const finalText = dispatched.steps.map((s) => s.text).filter(Boolean).join("\n\n");

      pushChunk?.({
        streamId,
        type: "done",
        toolCalls: [],
        message: {
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalText || "我没有生成有效回复。",
          createdAt: new Date().toISOString(),
          context: runtime.userContext,
        },
      });

      return {
        steps: dispatched.steps,
        finalText,
      };
    },
  });

  return createWorkflow({
    id: ROUTER_WORKFLOW_ID,
    inputSchema: RouterWorkflowInputSchema,
    outputSchema: RouterWorkflowOutputSchema,
  })
    .then(dispatchStep)
    .commit();
}
