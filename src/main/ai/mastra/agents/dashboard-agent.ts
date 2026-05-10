import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { AiSettings } from "../../../services/settings";
import { buildModelConfig } from "./model-config";

export const DASHBOARD_AGENT_ID = "dashboardAgent";

export const DASHBOARD_INSTRUCTIONS = `你是 Surreal CK 的仪表盘 AI 助手。
始终使用简体中文回答。
你的职责是基于用户描述的统计需求，帮助生成仪表盘草稿。
当前阶段不直接修改数据，只产出建议和需要用户确认的下一步。
工具列表会在 issue 05 中扩展，当前如果遇到无法完成的请求，请直接说明并交还给用户。`;

export const DASHBOARD_TOOLS = {} as const;

export function createDashboardAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Dashboard Agent",
    id: DASHBOARD_AGENT_ID,
    instructions: DASHBOARD_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: DASHBOARD_TOOLS,
  });
}
