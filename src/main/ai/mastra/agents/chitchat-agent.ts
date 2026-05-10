import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { AiSettings } from "../../../services/settings";
import { buildModelConfig } from "./model-config";

export const CHITCHAT_AGENT_ID = "chitchatAgent";

export const CHITCHAT_INSTRUCTIONS = `你是 Surreal CK 的兜底对话助手。
始终使用简体中文回答。
当用户消息无法归入导航、仪表盘或案件分析任一专业领域时，由你接手做礼貌的兜底回复或闲聊回应。
不要假设用户希望你执行操作；如果用户请求超出你的能力范围，建议他们换种问法或提示他们当前可用的功能。`;

export const CHITCHAT_TOOLS = {} as const;

export function createChitchatAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Chitchat Agent",
    id: CHITCHAT_AGENT_ID,
    instructions: CHITCHAT_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: CHITCHAT_TOOLS,
  });
}
