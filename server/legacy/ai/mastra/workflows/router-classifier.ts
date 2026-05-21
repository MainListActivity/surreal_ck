import { z } from "zod";

export const RouterCategorySchema = z.enum([
  "navigation",
  "dashboard",
  "claim-analysis",
  "resource-retrieval",
  "chitchat",
]);
export type RouterCategory = z.infer<typeof RouterCategorySchema>;

export const RouterPlanItemSchema = z.object({
  category: RouterCategorySchema,
  taskText: z.string().min(1),
});
export type RouterPlanItem = z.infer<typeof RouterPlanItemSchema>;

export const RouterPlanSchema = z.array(RouterPlanItemSchema).min(1);
export type RouterPlan = z.infer<typeof RouterPlanSchema>;

export type RouterLlmCaller = (prompt: string) => Promise<string>;

export const ROUTER_SYSTEM_PROMPT = `你是 Surreal CK 的意图路由器。把用户消息切分为按执行顺序排列的子任务列表。

可选 category：
- navigation：浏览/跳转/打开/搜索工作簿、Sheet、记录、仪表盘
- dashboard：让 AI 分析数据并生成统计图、图表、看板
- claim-analysis：分析具体某条记录（保单/案件等业务记录）
- resource-retrieval：检索、查找、引用已有资源/资料/知识库内容，或基于当前上下文找相似资料
- chitchat：闲聊、自我介绍、无法归入以上任一类的兜底

输出严格 JSON 数组，元素形如 {"category": "...", "taskText": "..."}，taskText 是从用户原话切分得到的自然语言子任务描述。
即使只有一个意图，也要包成长度为 1 的数组。`;

export function buildRouterPrompt(text: string): string {
  return `${ROUTER_SYSTEM_PROMPT}\n\n用户消息：${text}`;
}

export type ClassifyTaskInput = {
  text: string;
  llmCaller: RouterLlmCaller;
};

export function chitchatFallback(text: string): RouterPlan {
  return [{ category: "chitchat", taskText: text }];
}

export async function classifyTask(input: ClassifyTaskInput): Promise<RouterPlan> {
  const { text, llmCaller } = input;
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
