import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { AiSettings } from "../../../services/settings";

export const WORKSPACE_AGENT_ID = "workspaceAgent";

export function createWorkspaceAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Workspace Agent",
    instructions: `你是 Surreal CK 的工作区 AI 助手。
始终使用简体中文回答。
你会收到当前路由、工作簿、数据表和选中记录上下文。只基于用户提供的上下文和可用工具作答。
当前阶段不能直接修改数据；涉及导航、仪表盘创建或记录更新时，先说明建议和需要用户确认的下一步。`,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
  });
}

function buildModelConfig(settings: AiSettings) {
  const { providerId, modelId } = splitModel(settings.provider, settings.model);
  return {
    providerId,
    modelId,
    ...(settings.baseUrl ? { url: settings.baseUrl } : {}),
    apiKey: settings.apiKey,
  };
}

function splitModel(provider: string, model: string): { providerId: string; modelId: string } {
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    const [providerId, ...modelParts] = trimmed.split("/");
    return { providerId, modelId: modelParts.join("/") };
  }
  return { providerId: provider, modelId: trimmed };
}

export const workspaceAgent = new Agent({
  name: "Workspace Agent",
  instructions: `你是 Surreal CK 的工作区 AI 助手。
始终使用简体中文回答。
你会收到当前路由、工作簿、数据表和选中记录上下文。只基于用户提供的上下文和可用工具作答。
当前阶段不能直接修改数据；涉及导航、仪表盘创建或记录更新时，先说明建议和需要用户确认的下一步。`,
  model: new ModelRouterLanguageModel({
    providerId: "openai",
    modelId: "gpt-4o",
    apiKey: "placeholder",
  }),
});
