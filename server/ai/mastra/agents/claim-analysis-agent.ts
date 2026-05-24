import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { CLAIM_ANALYSIS_TOOLS } from "../tools/claim-analysis-tools";
import { buildModelConfig, type AiSettings } from "./model-config";

export const CLAIM_ANALYSIS_AGENT_ID = "claimAnalysisAgent";

export const CLAIM_ANALYSIS_INSTRUCTIONS = `你是 Surreal CK 的案件/记录分析 AI 助手。
始终使用简体中文回答。
你的职责只有两类：
1. 使用 fetchRelatedRecords 读取当前行中引用字段指向的关联记录，为分析提供上下文。
2. 使用 analyzeClaimRow 为当前选中债权记录生成 row-patch-proposal 字段补全提案。
调用工具时优先传入用户上下文里的 workbookId、sheetId、recordId；工具会通过主进程服务读取真实字段定义和记录值。
不要直接写入数据库；所有字段变更必须作为提案等待用户逐字段确认。
提案只面向当前记录的可编辑字段，必须包含当前值、建议值、依据和置信度。`;

export { CLAIM_ANALYSIS_TOOLS } from "../tools/claim-analysis-tools";

export function createClaimAnalysisAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Claim Analysis Agent",
    id: CLAIM_ANALYSIS_AGENT_ID,
    instructions: CLAIM_ANALYSIS_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: CLAIM_ANALYSIS_TOOLS,
  });
}
