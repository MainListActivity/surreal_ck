import { z } from "zod";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { DecisionModelError, type DecisionCaller, type DecisionRequest } from "../../decision/model";
import { outcomeForError } from "../../../src/ai/run-diagnostics";

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

export type RouterLlmCaller = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;

export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.75;

/**
 * 类目语义唯一事实源：ROUTER_SYSTEM_PROMPT 与 Jev 决策 criteria 都由它生成，禁止两处漂移。
 * 写入/字段修改意图必须显式落在 row-analysis——它名下挂着 analyzeRow / proposeRecordWrite，
 * 提案经 executor 转成 await-write-confirm 挂起态；chitchat 名下没有任何写工具，
 * 把数据操作归到这里等于把写入请求判死刑（生产三次复现的根因）。
 */
const ROUTER_CATEGORY_DEFINITIONS: Record<RouterCategory, string> = {
  navigation: "浏览/跳转/打开/搜索工作簿、数据表、记录、仪表盘等对象，只定位不改变数据",
  dashboard: "让 AI 分析数据并生成统计图、图表、看板",
  "row-analysis": "对具体记录的分析、补全或写入：查看/补全/修改某条记录的字段值、创建或更新记录（写入产出待用户逐字段确认的提案，不直接执行）",
  "resource-retrieval": "检索、查找、引用已有资源/资料/知识库内容，或基于当前上下文找相似资料",
  chitchat: "与工作簿数据无关的闲聊、问候、自我介绍；兜底仅用于不涉及工作簿、数据表、记录或字段操作的消息",
};

const ROUTER_SYSTEM_PROMPT = `你是 Surreal CK 的意图路由器。把用户消息切分为按执行顺序排列的子任务列表。

可选 category：
${Object.entries(ROUTER_CATEGORY_DEFINITIONS).map(([category, definition]) => `- ${category}：${definition}`).join("\n")}

判定要点：
- 要求新增、修改、填写、更新、删除记录或字段值的请求一律归入 row-analysis，绝不能归入 chitchat；
- 只读提问（解释字段含义、查看记录内容、检索资料）不算写入，按语义归 navigation / row-analysis / resource-retrieval；
- 「先定位记录再操作」的复合指令可拆成按顺序排列的多个子任务（先 navigation 定位，后其它操作）；
- 拿不准且与数据操作无关时才归 chitchat；涉及数据操作的含糊请求优先归 row-analysis。

示例：
- 「把「事项」为 A-001 的那一行的「状态」字段改为「待复核」」→ [{"category":"row-analysis","taskText":"把「事项」为 A-001 的那一行的「状态」字段改为「待复核」"}]
- 「打开销售工作簿，然后把选中行标记为已完成」→ [{"category":"navigation","taskText":"打开销售工作簿"},{"category":"row-analysis","taskText":"把选中行标记为已完成"}]
- 「你好」→ [{"category":"chitchat","taskText":"你好"}]

输出严格 JSON 数组，元素形如 {"category": "...", "taskText": "..."}，taskText 是从用户原话切分得到的自然语言子任务描述。
即使只有一个意图，也要包成长度为 1 的数组。`;

/** 决策模型 choice 题的 criteria：与 ROUTER_SYSTEM_PROMPT 同源生成。 */
const JEV_CATEGORY_CRITERIA = ROUTER_CATEGORY_DEFINITIONS;

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
  /** run 取消信号（PG-1：透传给 llmCaller → Mastra stream/generate）。 */
  signal?: AbortSignal;
};

function chitchatFallback(text: string): RouterPlan {
  return [{ category: "chitchat", taskText: text }];
}

// ─── 写入意图护栏 ────────────────────────────────────────────────────────────
//
// chitchat 名下没有任何写工具：写入指令被判给 chitchat 时兜底代理只读拒绝、
// 不产出 write-confirm 提案卡，等于写入路径死亡（生产三次复现 + QA 独立复现
// 的根因）。类目定义收紧后模型判决层仍存在随机漏判，因此在分类器出口加一条
// 确定性路由不变量：凡携带「写入动作 + 数据对象」信号的 plan 项，无论被判成
// 哪个无写工具的类目，一律回收为 row-analysis（唯一挂写工具的类目）。
// 护栏不臆造切分：模型正确切出的 navigation/chitchat 等无写入信号的项保持原样。

/**
 * 写入动作动词：新增/修改/填写/更新/删除/清空/替换/标记等「要求改变数据」的命令词。
 * 裸「改」排除改天/改进/改善等非写入词；其余一律多字词避免歧义。
 */
const WRITE_ACTION_PATTERN = new RegExp(
  [
    "改(?!(?:天|进|善|良|革|观|邪|道|派|头|口|朝|装|编|版|造|组))(?:为|成|到|下|一下|掉|好|写|动|正|变|名|作|过来|过去)?",
    "修改|修正|更正|订正|更新|更改|变更",
    "设置为|设定为|设为|置为|定为|记为|标为|标成|标记为|标记|标注|标上",
    "填写|填入|填上|填充|填报|填好|填个|填完|填满",
    "写入|录入|补录|登记",
    "删(?:除|掉|去|下|了|一|完)",
    "移除|去掉|去除|清空|清除|抹掉",
    "新增|添加|增加|加上|加个|插入|创建|新建",
    "补一?(?:条|行|个|项|份)|生成一?(?:条|行|个|份)",
    "换成|换为|换掉|替换|替代|调整|更名|重命名|改名叫",
    "备注",
    "\\b(?:update|delete|remove|add|create|set|change|modify|fill|mark|rename)\\b",
  ].join("|"),
  "i",
);

/**
 * 数据对象：工作簿域内可被写入的对象。短词（行/条/个/列…）必须带量词或
 * 指示代词前缀才作数，避免「进行」「一行代码」误伤；字段/记录/状态等
 * 域内专有名词可独立成立。
 */
const DATA_OBJECT_PATTERN = new RegExp(
  [
    "字段", "记录", "单元格", "格子", "状态", "条目", "属性", "备注", "标签",
    "数据表", "数据", "清单", "台账", "名单", "事项", "内容", "名字", "名称", "值", "栏位",
    "(?:这|那|该|本|选中|当前|对应|同一|每|所有|全部|任一|第\\s*\\d+|\\d+|[一二两三四五六七八九十]+)\\s*(?:行|条|个|项|列|栏|笔|单|号|份|张)",
    "它|其|本条|该行|此行|这条|该条|此条",
    "\\b(?:row|record|field|cell|status|column|value|item|entry)\\b",
  ].join("|"),
  "i",
);

/**
 * 强写入动词：省略宾语的祈使句（「改成待复核」「删掉吧」）只能由强动词 + 页面
 * 上下文兜底成立。排除了「设置」「调整」「生成」这类兼作页面名/弱语义的词。
 */
const STRONG_WRITE_ACTION_PATTERN = new RegExp(
  [
    "改为|改成|改到|改下|改一下|改掉|改好|改写|改动|改名",
    "修改|更正|更新为|变更为",
    "设定为|设置为|设为|置为|定为|记为|标为|标成|标记为|标记",
    "填写|填入|填上|写入|录入|补录|登记",
    "删(?:除|掉|去|下|了|一|完)|移除|去掉|清空|清除",
    "新增|添加|加上|加个|插入|创建|新建",
    "换成|换为|换掉|替换|更名|重命名",
    "\\b(?:update|delete|remove|add|create|set|change|modify|fill|mark|rename)\\b",
  ].join("|"),
  "i",
);

/** 判定一段文本是否携带「要求写入数据」的信号。 */
export function hasWriteIntentSignal(text: string, ctx?: AiContextSnapshot): boolean {
  if (!WRITE_ACTION_PATTERN.test(text)) return false;
  if (DATA_OBJECT_PATTERN.test(text)) return true;
  // 省略宾语的祈使写入依赖页面上下文兜底：有选中行/表时「改成待复核」指向当前行
  return Boolean(ctx?.selectedRow ?? ctx?.sheet) && STRONG_WRITE_ACTION_PATTERN.test(text);
}

/**
 * 对分类结果应用写入意图护栏。逐项检查 taskText；若整个 plan 全是 chitchat
 * （模型整体漏判），用原始消息兜底判定——taskText 可能被模型改写丢掉信号。
 */
export function applyWriteIntentGuard(
  text: string,
  plan: RouterPlan,
  ctx?: AiContextSnapshot,
): RouterPlan {
  const allChitchat = plan.every((item) => item.category === "chitchat");
  let fired = false;
  const guarded = plan.map((item) => {
    if (item.category === "row-analysis") return item;
    const hit =
      hasWriteIntentSignal(item.taskText, ctx) ||
      (allChitchat && hasWriteIntentSignal(text, ctx));
    if (!hit) return item;
    fired = true;
    return { ...item, category: "row-analysis" as RouterCategory };
  });
  if (fired) {
    console.info("[router]", {
      kind: "write-intent-guard",
      from: plan.map((item) => item.category),
      to: guarded.map((item) => item.category),
    });
  }
  return guarded;
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
        instructions:
          "用户消息最主要属于哪个类别？请结合 context 中的页面与选中状态判断。" +
          "要求新增、修改、填写、更新、删除记录或字段值的消息属于 row-analysis，不属于 chitchat。",
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
    if (plan) return applyWriteIntentGuard(text, plan, input.userContext);
  }

  const prompt = buildRouterPrompt(text);
  try {
    const raw = await llmCaller(prompt, input.signal ? { signal: input.signal } : undefined);
    const parsed = JSON.parse(raw);
    const validated = RouterPlanSchema.safeParse(parsed);
    const plan = validated.success ? validated.data : chitchatFallback(text);
    return applyWriteIntentGuard(text, plan, input.userContext);
  } catch (error) {
    // PG-1：取消/超时不得被吞成 chitchat 兜底计划——重抛，让 run 以具名错误终止。
    if (input.signal?.aborted || outcomeForError(error) !== "failed") throw error;
    return applyWriteIntentGuard(text, chitchatFallback(text), input.userContext);
  }
}
