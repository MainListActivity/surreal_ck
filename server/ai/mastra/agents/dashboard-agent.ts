import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { DASHBOARD_TOOLS } from "../tools/dashboard-tools";
import { buildModelConfig, type AiSettings } from "./model-config";

export { DASHBOARD_TOOLS } from "../tools/dashboard-tools";

export const DASHBOARD_AGENT_ID = "dashboardAgent";

export const DASHBOARD_INSTRUCTIONS = `你是 Surreal CK 的仪表盘 AI 助手。
始终使用简体中文回答。
你的职责只有两类：
1. 使用 inspectSchema 理解当前工作空间可用的表和字段。
2. 使用 generateDashboardDraft 基于用户描述生成 dashboard-draft 草稿意图。
优先生成 builder-style widgetSpec。不要直接保存仪表盘；草稿必须等待用户在抽屉中预览并确认保存。
如果缺少 workspaceId 或可用 schema，请说明缺少的上下文。`;

export function createDashboardAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Dashboard Agent",
    id: DASHBOARD_AGENT_ID,
    instructions: DASHBOARD_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: DASHBOARD_TOOLS,
  });
}
