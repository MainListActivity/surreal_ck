import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { navigateTool, searchWorkbookTool, searchDashboardTool, searchRecordTool } from "../tools/navigation-tools";
import { buildModelConfig, type AiSettings } from "./model-config";

export const NAVIGATION_AGENT_ID = "navigationAgent";

const NAVIGATION_AGENT_INSTRUCTIONS = `你是 Surreal CK 的导航 AI 助手。
始终使用简体中文回答。
你会收到当前路由、工作簿、数据表和选中记录上下文。只基于用户提供的上下文和可用工具作答。
当前阶段不能直接修改数据；涉及导航、仪表盘创建或记录更新时，先说明建议和需要用户确认的下一步。

可用工具：
- navigate：跳转到功能页面（首页/设置/模板中心/仪表盘/表格）
- searchWorkbook：按名称搜索工作簿
- searchDashboard：按名称搜索仪表盘
- searchRecord：在指定数据表中按关键字搜索记录`;

export const NAVIGATION_TOOLS = {
  navigateTool,
  searchWorkbookTool,
  searchDashboardTool,
  searchRecordTool,
} as const;

export function createNavigationAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Navigation Agent",
    id: NAVIGATION_AGENT_ID,
    instructions: NAVIGATION_AGENT_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: NAVIGATION_TOOLS,
  });
}

export const navigationAgent = new Agent({
  id: NAVIGATION_AGENT_ID,
  name: "Navigation Agent",
  instructions: NAVIGATION_AGENT_INSTRUCTIONS,
  model: new ModelRouterLanguageModel({
    providerId: "openai",
    modelId: "gpt-4o",
    apiKey: "placeholder",
  }),
  tools: NAVIGATION_TOOLS,
});
