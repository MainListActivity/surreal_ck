import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";
import { createClaimAnalysisAgent } from "./claim-analysis-agent";
import type { AiSettings } from "./model-config";

const fakeSettings: AiSettings = {
  provider: "openai",
  model: "unused-by-fake-model",
  apiFormat: "openai-compatible",
  apiKey: "placeholder-key",
  secretConfigured: true,
};

const selectedClaimContext: AiContextSnapshot = {
  route: { screen: "editor", workbookId: "workbook:claims", sheetId: "sheet:creditors" },
  workbook: { id: "workbook:claims", name: "债权台账" },
  sheet: { id: "sheet:creditors", label: "债权人", tableName: "ent_creditors" },
  selectedRow: {
    id: "ent_creditors:yuanhang",
    label: "远航供应链有限公司",
    visibleValues: { declared_amount: 1_200_000, review_status: "部分确认" },
  },
  contextHint: "债权人 / 远航供应链有限公司",
};

type ModelCall = { prompt?: unknown };

async function createPromptCapturingModel(calls: ModelCall[]) {
  // Mastra 1.36 发布了该测试入口，但包内遗漏了对应 .d.ts；运行时 API 是官方测试工具。
  // @ts-expect-error @mastra/core 1.36.0 test-utils/llm-mock 缺少声明文件
  const { createMockModel } = await import("@mastra/core/test-utils/llm-mock");
  return createMockModel({
    mockText: "测试回答",
    spyStream: (call: ModelCall) => calls.push(call),
  });
}

describe("claim-analysis agent 模板 instructions", () => {
  test("Agent.stream 把当前工作簿模板的领域背景、字段语义和检查重点交给模型", async () => {
    const modelCalls: ModelCall[] = [];
    const model = await createPromptCapturingModel(modelCalls);
    const session = {
      async query() {
        return [[{
          row_analysis: {
            background: "这是破产债权申报审核台账。",
            field_semantics: [
              { field_key: "declared_amount", meaning: "债权人申报的债权金额" },
              { field_key: "evidence_status", meaning: "申报材料是否齐全" },
            ],
            review_points: [
              "摘要覆盖申报金额、审核状态、材料情况和引用依据",
              "风险清单区分缺失信息、金额异常、疑似重复和期限风险",
            ],
            output_guidance: ["结论必须说明台账事实与模型建议的边界"],
          },
        }]];
      },
    };
    const requestContext = new RequestContext();
    requestContext.set(ROUTER_RUNTIME_KEY, {
      surrealSession: session,
      userContext: selectedClaimContext,
    });
    const agent = createClaimAnalysisAgent(fakeSettings, { model });

    const stream = await agent.stream("生成当前记录的审核摘要", { requestContext });
    await stream.text;

    const prompt = JSON.stringify(modelCalls[0]?.prompt);
    expect(prompt).toContain("这是破产债权申报审核台账");
    expect(prompt).toContain("declared_amount：债权人申报的债权金额");
    expect(prompt).toContain("摘要覆盖申报金额、审核状态、材料情况和引用依据");
    expect(prompt).toContain("缺失信息、金额异常、疑似重复和期限风险");
    expect(prompt).toContain("结论必须说明台账事实与模型建议的边界");
  });

  test("无领域提示的工作簿继续使用通用行分析，system prompt 不出现债权措辞", async () => {
    const modelCalls: ModelCall[] = [];
    const model = await createPromptCapturingModel(modelCalls);
    const session = { async query() { return [[{ row_analysis: undefined }]]; } };
    const requestContext = new RequestContext();
    requestContext.set(ROUTER_RUNTIME_KEY, {
      surrealSession: session,
      userContext: {
        ...selectedClaimContext,
        route: { ...selectedClaimContext.route, workbookId: "workbook:plain" },
        workbook: { id: "workbook:plain", name: "普通运营台账" },
        sheet: { id: "sheet:items", label: "事项", tableName: "ent_items" },
        selectedRow: null,
      },
    });
    const agent = createClaimAnalysisAgent(fakeSettings, { model });

    const stream = await agent.stream("分析当前记录", { requestContext });
    await stream.text;

    const prompt = JSON.stringify(modelCalls[0]?.prompt);
    expect(prompt).toContain("通用记录分析");
    expect(prompt).not.toContain("破产");
    expect(prompt).not.toContain("债权");
    expect(prompt).not.toContain("申报金额");
  });
});
