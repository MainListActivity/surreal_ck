import { buildAgentModel } from "../../../src/internal-ai/model";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { StringRecordId, type Surreal } from "surrealdb";
import { ROW_ANALYSIS_TOOLS } from "../tools/row-analysis-tools";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";
import { getExecutionContext } from "../execution-context";
import { type AiSettings } from "./model-config";

export const ROW_ANALYSIS_AGENT_ID = "rowAnalysisAgent";

/**
 * 行分析无可见产出时的契约化显式态（def-row-analysis-no-proposal 修复）。
 * reasoning 模型可能只思考不落地（全部产出落在 reasoning 通道），此时不得把空回复
 * 伪装成有效回答；executor 用这句替换空文本，用户看到的是明确的「未生成提案」。
 */
export const ROW_ANALYSIS_NO_PROPOSAL_TEXT = "未生成字段补全提案：模型本轮没有给出可确认的字段建议。请补充当前记录的相关信息后重试。";

export const ROW_ANALYSIS_INSTRUCTIONS = `你是 Surreal CK 的通用记录分析 AI 助手。
始终使用简体中文回答。
你的职责只有三类：
1. 使用 fetchRelatedRecords 获取分析上下文：优先使用当前记录的关联资源；有资源时在回答中用 [1] 这类编号引用依据。无关联资源时，工具会回退读取当前行 reference 字段指向的普通关联记录。
2. 使用 analyzeRow 为当前选中记录生成 row-patch-proposal 字段补全提案。
3. 使用 proposeRecordWrite 为其它数据表生成 record-write-proposal 创建/更新提案。
调用工具时优先传入用户上下文里的 workbookId、sheetId、recordId；工具会通过调用者会话读取真实字段定义和记录值。
不要直接写入数据库；所有字段变更必须作为提案等待用户逐字段确认。
提案只面向当前记录的可编辑字段，必须包含当前值、建议值、依据和置信度。
没有关联资源时，必须明确区分台账中的可核验事实与模型给出的分析建议。
输出契约（必须遵守）：
- 每一轮思考都必须落地为可见结果：调用工具，或用一句简体中文给出明确结论；禁止只推理不输出。
- 确实无法给出字段补全建议时，调用 analyzeRow 并传空 suggestions 数组，让界面呈现「未生成提案」的明确状态；不要用空回复收尾。`;

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

type RowAnalysisRuntime = {
  userContext?: AiContextSnapshot;
};

export type RowAnalysisAgentDeps = {
  model?: MastraModelConfig;
  loadTemplateRowAnalysis?: typeof loadTemplateRowAnalysis;
};

/** 通过调用者 session 读取当前工作簿引用的模板提示；空白工作簿返回 null。 */
async function loadTemplateRowAnalysis(
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

function buildRowAnalysisInstructions(analysis: TemplateRowAnalysis | null): string {
  if (!analysis) return ROW_ANALYSIS_INSTRUCTIONS;
  const sections = [
    ROW_ANALYSIS_INSTRUCTIONS,
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

export { ROW_ANALYSIS_TOOLS } from "../tools/row-analysis-tools";

export function createRowAnalysisAgent(settings: AiSettings, deps: RowAnalysisAgentDeps = {}): Agent {
  const loadAnalysis = deps.loadTemplateRowAnalysis ?? loadTemplateRowAnalysis;
  return new Agent({
    name: "Row Analysis Agent",
    id: ROW_ANALYSIS_AGENT_ID,
    instructions: async ({ requestContext }) => {
      const runtime = requestContext?.get(ROUTER_RUNTIME_KEY) as RowAnalysisRuntime | undefined;
      // 会话只从共享执行上下文取；缺席时 fail-soft 回退到通用 instructions。
      const surrealSession = getExecutionContext(requestContext)?.surrealSession;
      const workbookId = runtime?.userContext?.workbook?.id ?? runtime?.userContext?.route.workbookId;
      if (!surrealSession || !workbookId) return ROW_ANALYSIS_INSTRUCTIONS;
      return buildRowAnalysisInstructions(await loadAnalysis(surrealSession, workbookId));
    },
    model: deps.model ?? buildAgentModel(settings, "row-analysis-agent"),
    tools: ROW_ANALYSIS_TOOLS,
  });
}
