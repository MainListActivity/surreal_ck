import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel, type MastraModelConfig } from "@mastra/core/llm";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { StringRecordId, type Surreal } from "surrealdb";
import { CLAIM_ANALYSIS_TOOLS } from "../tools/claim-analysis-tools";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";
import { buildModelConfig, type AiSettings } from "./model-config";

export const CLAIM_ANALYSIS_AGENT_ID = "claimAnalysisAgent";

export const CLAIM_ANALYSIS_INSTRUCTIONS = `你是 Surreal CK 的通用记录分析 AI 助手。
始终使用简体中文回答。
你的职责只有两类：
1. 使用 fetchRelatedRecords 获取分析上下文：优先使用当前记录的关联资源；有资源时在回答中用 [1] 这类编号引用依据。无关联资源时，工具会回退读取当前行 reference 字段指向的普通关联记录。
2. 使用 analyzeClaimRow 为当前选中记录生成 row-patch-proposal 字段补全提案。
3. 使用 proposeRecordWrite 为其它数据表生成 record-write-proposal 创建/更新提案。
调用工具时优先传入用户上下文里的 workbookId、sheetId、recordId；工具会通过调用者会话读取真实字段定义和记录值。
不要直接写入数据库；所有字段变更必须作为提案等待用户逐字段确认。
提案只面向当前记录的可编辑字段，必须包含当前值、建议值、依据和置信度。
没有关联资源时，必须明确区分台账中的可核验事实与模型给出的分析建议。`;

export type TemplateRowAnalysis = {
  background: string;
  fieldSemantics: Array<{ fieldKey: string; meaning: string }>;
  reviewPoints: string[];
  outputGuidance: string[];
};

type StoredTemplateRowAnalysis = {
  background?: unknown;
  field_semantics?: unknown;
  review_points?: unknown;
  output_guidance?: unknown;
};

type ClaimAnalysisRuntime = {
  surrealSession?: Surreal;
  userContext?: AiContextSnapshot;
};

export type ClaimAnalysisAgentDeps = {
  model?: MastraModelConfig;
  loadTemplateRowAnalysis?: typeof loadTemplateRowAnalysis;
};

/** 通过调用者 session 读取当前工作簿引用的模板提示；空白工作簿返回 null。 */
export async function loadTemplateRowAnalysis(
  session: Surreal,
  workbookId: string,
): Promise<TemplateRowAnalysis | null> {
  const result = await session.query(
    "SELECT template.row_analysis AS row_analysis FROM $workbook LIMIT 1 FETCH template",
    { workbook: new StringRecordId(workbookId) },
  );
  const firstStatement = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
  const stored = (firstStatement[0] as { row_analysis?: StoredTemplateRowAnalysis } | undefined)?.row_analysis;
  if (!stored || typeof stored.background !== "string" || stored.background.trim() === "") return null;

  const fieldSemantics = Array.isArray(stored.field_semantics)
    ? stored.field_semantics.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as { field_key?: unknown; meaning?: unknown };
        return typeof item.field_key === "string" && typeof item.meaning === "string"
          ? [{ fieldKey: item.field_key, meaning: item.meaning }]
          : [];
      })
    : [];
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  return {
    background: stored.background,
    fieldSemantics,
    reviewPoints: strings(stored.review_points),
    outputGuidance: strings(stored.output_guidance),
  };
}

export function buildClaimAnalysisInstructions(analysis: TemplateRowAnalysis | null): string {
  if (!analysis) return CLAIM_ANALYSIS_INSTRUCTIONS;
  const sections = [
    CLAIM_ANALYSIS_INSTRUCTIONS,
    "",
    "当前工作簿模板提供的领域分析说明（仅适用于本次运行）：",
    `领域背景：${analysis.background}`,
  ];
  if (analysis.fieldSemantics.length > 0) {
    sections.push("字段语义：", ...analysis.fieldSemantics.map((item) => `- ${item.fieldKey}：${item.meaning}`));
  }
  if (analysis.reviewPoints.length > 0) {
    sections.push("检查重点：", ...analysis.reviewPoints.map((item) => `- ${item}`));
  }
  if (analysis.outputGuidance.length > 0) {
    sections.push("输出要求：", ...analysis.outputGuidance.map((item) => `- ${item}`));
  }
  return sections.join("\n");
}

export { CLAIM_ANALYSIS_TOOLS } from "../tools/claim-analysis-tools";

export function createClaimAnalysisAgent(settings: AiSettings, deps: ClaimAnalysisAgentDeps = {}): Agent {
  const loadAnalysis = deps.loadTemplateRowAnalysis ?? loadTemplateRowAnalysis;
  return new Agent({
    name: "Claim Analysis Agent",
    id: CLAIM_ANALYSIS_AGENT_ID,
    instructions: async ({ requestContext }) => {
      const runtime = requestContext?.get(ROUTER_RUNTIME_KEY) as ClaimAnalysisRuntime | undefined;
      const workbookId = runtime?.userContext?.workbook?.id ?? runtime?.userContext?.route.workbookId;
      if (!runtime?.surrealSession || !workbookId) return CLAIM_ANALYSIS_INSTRUCTIONS;
      return buildClaimAnalysisInstructions(await loadAnalysis(runtime.surrealSession, workbookId));
    },
    model: deps.model ?? new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: CLAIM_ANALYSIS_TOOLS,
  });
}
