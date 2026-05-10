import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { AiSettings } from "../../../services/settings";
import { buildModelConfig } from "./model-config";

export const CLAIM_ANALYSIS_AGENT_ID = "claimAnalysisAgent";

export const CLAIM_ANALYSIS_INSTRUCTIONS = `你是 Surreal CK 的案件/记录分析 AI 助手。
始终使用简体中文回答。
你的职责是基于用户选中的某条业务记录，结合上下文做要点提取与分析。
当前阶段不直接修改数据，只产出分析结论和需要用户确认的下一步。
工具列表会在 issue 06 中扩展，当前如果遇到无法完成的请求，请直接说明并交还给用户。`;

export const CLAIM_ANALYSIS_TOOLS = {} as const;

export function createClaimAnalysisAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Claim Analysis Agent",
    id: CLAIM_ANALYSIS_AGENT_ID,
    instructions: CLAIM_ANALYSIS_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: CLAIM_ANALYSIS_TOOLS,
  });
}
