import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { AiContextSnapshot } from "../../../../shared/ai-context";
import { classifyTask, type RouterCategory, type RouterLlmCaller, type RouterPlan } from "./router-classifier";

export const ROUTER_WORKFLOW_ID = "routerWorkflow";

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

/**
 * createRouterWorkflow 返回一个 Mastra workflow。
 * V1 单步包整个 routeAndDispatch；issue 012 会按子 agent 拆成多个 step 以支持 ambiguous suspend/resume。
 *
 * executors / llmCaller / userContext 通过 requestContext 注入，让 workflow 实例本身可复用。
 */
export function createRouterWorkflow() {
  const dispatchStep = createStep({
    id: "route-and-dispatch",
    inputSchema: RouterWorkflowInputSchema,
    outputSchema: RouterWorkflowOutputSchema,
    execute: async ({ inputData, requestContext }) => {
      const ctx = (requestContext ?? {}) as Partial<RouterWorkflowContext>;
      assertRouterWorkflowContext(ctx);
      const result = await routeAndDispatch({
        text: inputData.text,
        shared: { userContext: ctx.userContext, confirmed: {} },
        executors: ctx.executors,
        llmCaller: ctx.llmCaller,
      });
      return {
        steps: result.steps,
        finalText: result.steps.map((s) => s.text).filter(Boolean).join("\n\n"),
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

export type RouterWorkflowContext = {
  userContext: AiContextSnapshot;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
};

function assertRouterWorkflowContext(ctx: Partial<RouterWorkflowContext>): asserts ctx is RouterWorkflowContext {
  if (!ctx.userContext || !ctx.executors || !ctx.llmCaller) {
    throw new Error("router-workflow: requestContext 缺少 userContext/executors/llmCaller");
  }
}
