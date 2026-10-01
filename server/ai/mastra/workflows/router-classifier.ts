import { z } from "zod";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { DecisionModelError, type DecisionCaller, type DecisionRequest } from "../../decision/model";

const CanonicalRouterCategorySchema = z.enum([
  "navigation",
  "dashboard",
  "row-analysis",
  "resource-retrieval",
  "chitchat",
]);
export type RouterCategory = z.infer<typeof CanonicalRouterCategorySchema>;

/** 旧类目仅作为输入别名归一化到现行类目；归一化后的输出不再携带旧名。 */
const LEGACY_ROUTER_CATEGORY_ALIASES: Record<string, RouterCategory> = {
  "claim-analysis": "row-analysis",
};

export function normalizeRouterCategory(value: unknown): RouterCategory | null {
  if (typeof value !== "string") return null;
  const parsed = CanonicalRouterCategorySchema.safeParse(LEGACY_ROUTER_CATEGORY_ALIASES[value] ?? value);
  return parsed.success ? parsed.data : null;
}

export const RouterCategorySchema = z.string().transform((value, ctx) => {
  const normalized = normalizeRouterCategory(value);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: `未知路由类目: ${value}` });
    return z.NEVER;
  }
  return normalized;
});

const RouterPlanItemSchema = z.object({
  category: RouterCategorySchema,
  taskText: z.string().min(1),
});
export const RouterPlanSchema = z.array(RouterPlanItemSchema).min(1);
export type RouterPlan = z.infer<typeof RouterPlanSchema>;

export type RouterLlmCaller = (prompt: string) => Promise<string>;

export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.75;

const ROUTER_SYSTEM_PROMPT = `你是 Surreal CK 的意图路由器。把用户消息切分为按执行顺序排列的子任务列表。

可选 category：
- navigation：浏览/跳转/打开/搜索工作簿、Sheet、记录、仪表盘
- dashboard：让 AI 分析数据并生成统计图、图表、看板
- row-analysis：分析具体某条记录（当前选中行的字段值、关联记录与缺失项）
- resource-retrieval：检索、查找、引用已有资源/资料/知识库内容，或基于当前上下文找相似资料
- chitchat：闲聊、自我介绍、无法归入以上任一类的兜底

输出严格 JSON 数组，元素形如 {"category": "...", "taskText": "..."}，taskText 是从用户原话切分得到的自然语言子任务描述。
即使只有一个意图，也要包成长度为 1 的数组。`;

/** 与 ROUTER_SYSTEM_PROMPT 类别定义保持一致：决策模型 choice 题的 criteria。 */
const JEV_CATEGORY_CRITERIA: Record<RouterCategory, string> = {
  navigation: "浏览/跳转/打开/搜索工作簿、数据表、记录、仪表盘",
  dashboard: "让 AI 分析数据并生成统计图、图表、看板",
  "row-analysis": "分析具体某条记录（当前选中行的字段值、关联记录与缺失项）",
  "resource-retrieval": "检索、查找、引用已有资源/资料/知识库内容，或基于当前上下文找相似资料",
  chitchat: "闲聊、自我介绍、无法归入以上任一类的兜底",
};

function buildRouterPrompt(text: string): string {
  return `${ROUTER_SYSTEM_PROMPT}\n\n用户消息：${text}`;
}

export type JevClassifyLog = {
  /** 是否采用了决策模型答案（false = 回退 LLM 重分类）。 */
  adopted: boolean;
  /** 回退原因：multi-intent / low-confidence / invalid-answer / error。 */
  reason?: string;
  multiProb?: number;
  category?: string;
  categoryConfidence?: number;
  /** 决策模型实际回答的版本化模型 id。 */
  model?: string;
  latencyMs: number;
  errorKind?: string;
};

const defaultJevLog = (event: JevClassifyLog): void => {
  console.info("[jev]", event);
};

export type ClassifyTaskInput = {
  text: string;
  llmCaller: RouterLlmCaller;
  /** 可选决策模型；缺席时直接走 LLM 路径（与接入前行为一致）。 */
  decisionModel?: DecisionCaller;
  /** 作为决策输入一部分的 AI 上下文快照（紧凑化后送入 state）。 */
  userContext?: AiContextSnapshot;
  /** 决策置信度阈值，默认 0.75。 */
  confidenceThreshold?: number;
  /** 每次决策调用的结构化日志回调；默认 console.info("[jev]", ...)。 */
  onJevDecision?: (event: JevClassifyLog) => void;
};

function chitchatFallback(text: string): RouterPlan {
  return [{ category: "chitchat", taskText: text }];
}

function compactContext(ctx?: AiContextSnapshot) {
  if (!ctx) return undefined;
  return {
    screen: ctx.route.screen,
    workbook: ctx.workbook?.name ?? undefined,
    sheet: ctx.sheet?.label ?? undefined,
    selectedRow: ctx.selectedRow?.label ?? undefined,
    contextHint: ctx.contextHint || undefined,
  };
}

export function buildJevClassifyRequest(text: string, userContext?: AiContextSnapshot): DecisionRequest {
  return {
    state: {
      message: text,
      context: compactContext(userContext),
    },
    questions: {
      multi_intent: {
        type: "noul",
        instructions: "用户消息是否包含需要不同类别子任务分别处理的多个意图？",
      },
      category: {
        type: "choice",
        instructions: "用户消息最主要属于哪个类别？请结合 context 中的页面与选中状态判断。",
        criteria: JEV_CATEGORY_CRITERIA,
      },
    },
  };
}

/**
 * 决策模型路径：一次 batch 问 multi_intent + category。
 * 返回非 null 表示采用（单意图捷径）；返回 null 表示应回退 LLM。
 * 门控规则（threshold=T，默认 0.75）：
 *   - multi.noul >= T           → 判为多意图消息 → LLM（Jev 切不出有序 plan）
 *   - multi.noul <= 1-T 且 cat.confidence >= T → 采用 Jev 答案
 *   - 其余（撕裂区间或类别不自信）→ LLM
 */
async function tryJevClassify(
  input: ClassifyTaskInput,
  threshold: number,
  report: (event: JevClassifyLog) => void,
): Promise<RouterPlan | null> {
  const started = Date.now();
  let result: Awaited<ReturnType<DecisionCaller>>;
  try {
    result = await input.decisionModel!(buildJevClassifyRequest(input.text, input.userContext));
  } catch (error) {
    report({
      adopted: false,
      reason: "error",
      errorKind: error instanceof DecisionModelError ? error.kind : "unknown",
      latencyMs: Date.now() - started,
    });
    return null;
  }

  const base = { latencyMs: Date.now() - started, model: result.model };
  const multi = result.answers["multi_intent"];
  const cat = result.answers["category"];
  if (multi?.type !== "noul" || cat?.type !== "choice") {
    report({ ...base, adopted: false, reason: "invalid-answer" });
    return null;
  }

  const log = {
    ...base,
    multiProb: multi.noul,
    category: cat.choice,
    categoryConfidence: cat.confidence,
  };

  if (multi.noul >= threshold) {
    report({ ...log, adopted: false, reason: "multi-intent" });
    return null;
  }
  if (multi.noul > 1 - threshold || cat.confidence < threshold) {
    report({ ...log, adopted: false, reason: "low-confidence" });
    return null;
  }

  const category = RouterCategorySchema.safeParse(cat.choice);
  if (!category.success) {
    report({ ...log, adopted: false, reason: "invalid-answer" });
    return null;
  }

  report({ ...log, adopted: true });
  return [{ category: category.data, taskText: input.text }];
}

export async function classifyTask(input: ClassifyTaskInput): Promise<RouterPlan> {
  const { text, llmCaller } = input;

  if (input.decisionModel) {
    const plan = await tryJevClassify(
      input,
      input.confidenceThreshold ?? DEFAULT_JEV_CONFIDENCE_THRESHOLD,
      input.onJevDecision ?? defaultJevLog,
    );
    if (plan) return plan;
  }

  const prompt = buildRouterPrompt(text);
  try {
    const raw = await llmCaller(prompt);
    const parsed = JSON.parse(raw);
    const validated = RouterPlanSchema.safeParse(parsed);
    if (!validated.success) return chitchatFallback(text);
    return validated.data;
  } catch {
    return chitchatFallback(text);
  }
}
