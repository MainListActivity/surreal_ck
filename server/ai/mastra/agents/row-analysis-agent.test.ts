import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";
import { setExecutionContext } from "../execution-context";
import { createRowAnalysisAgent } from "./row-analysis-agent";
import type { AiSettings } from "./model-config";

const fakeSettings: AiSettings = {
  provider: "openai",
  model: "unused-by-fake-model",
  apiFormat: "openai-compatible",
  apiKey: "placeholder-key",
  secretConfigured: true,
};

// 夹具用自制合成领域（设备巡检），刻意不带任何特定领域语义：
// 领域提示来自模板数据行，平台测试不应依赖某个具体垂直包内容。
const selectedRowContext: AiContextSnapshot = {
  route: { screen: "editor", workbookId: "workbook:inspection", sheetId: "sheet:devices" },
  workbook: { id: "workbook:inspection", name: "设备巡检台账" },
  sheet: { id: "sheet:devices", label: "设备", tableName: "ent_devices" },
  selectedRow: {
    id: "ent_devices:pump-7",
    label: "冷却泵 7 号",
    visibleValues: { last_checked_at: "2026-09-01", check_status: "待复核" },
  },
  contextHint: "设备 / 冷却泵 7 号",
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

function ctxWith(session: unknown, userContext: AiContextSnapshot): RequestContext {
  const requestContext = new RequestContext();
  setExecutionContext(requestContext, { surrealSession: session as never });
  requestContext.set(ROUTER_RUNTIME_KEY, { userContext });
  return requestContext;
}

describe("row-analysis agent 模板 instructions", () => {
  test("Agent.stream 把当前工作簿模板的领域背景、字段语义和检查重点交给模型", async () => {
    const modelCalls: ModelCall[] = [];
    const model = await createPromptCapturingModel(modelCalls);
    const queriedWorkbooks: unknown[] = [];
    const session = {
      async query(_sql: string, params?: Record<string, unknown>) {
        queriedWorkbooks.push(String(params?.workbook));
        return [[{
          row_analysis: {
            background: "这是设备巡检台账。",
            field_semantics: [
              { field_key: "last_checked_at", meaning: "最近一次巡检日期" },
              { field_key: "check_status", meaning: "巡检结论是否已复核" },
            ],
            review_points: [
              "摘要覆盖巡检日期、复核状态与引用依据",
              "异常清单区分超期未检与读数异常",
            ],
            output_guidance: ["结论必须说明台账事实与模型建议的边界"],
          },
        }]];
      },
    };
    const agent = createRowAnalysisAgent(fakeSettings, { model });

    const stream = await agent.stream("生成当前记录的巡检摘要", {
      requestContext: ctxWith(session, selectedRowContext),
    });
    await stream.text;

    expect(queriedWorkbooks).toEqual(["workbook:inspection"]);
    const prompt = JSON.stringify(modelCalls[0]?.prompt);
    expect(prompt).toContain("这是设备巡检台账");
    expect(prompt).toContain("last_checked_at：最近一次巡检日期");
    expect(prompt).toContain("摘要覆盖巡检日期、复核状态与引用依据");
    expect(prompt).toContain("超期未检与读数异常");
    expect(prompt).toContain("结论必须说明台账事实与模型建议的边界");
  });

  test("无领域提示的工作簿继续使用通用行分析，instructions 不含模板内容", async () => {
    const modelCalls: ModelCall[] = [];
    const model = await createPromptCapturingModel(modelCalls);
    const session = { async query() { return [[{ row_analysis: undefined }]]; } };
    const agent = createRowAnalysisAgent(fakeSettings, { model });

    const stream = await agent.stream("分析当前记录", {
      requestContext: ctxWith(session, {
        ...selectedRowContext,
        route: { ...selectedRowContext.route, workbookId: "workbook:plain" },
        workbook: { id: "workbook:plain", name: "普通运营台账" },
        sheet: { id: "sheet:items", label: "事项", tableName: "ent_items" },
        selectedRow: null,
      }),
    });
    await stream.text;

    const prompt = JSON.stringify(modelCalls[0]?.prompt);
    expect(prompt).toContain("通用记录分析");
    expect(prompt).not.toContain("设备巡检");
    expect(prompt).not.toContain("领域背景");
  });

  test("模板记录被删除（dangling template 引用查不回 row_analysis）时回退通用且不报错", async () => {
    const modelCalls: ModelCall[] = [];
    const model = await createPromptCapturingModel(modelCalls);
    // 工作簿的 template 引用指向已删除记录：FETCH 后 row_analysis 缺省
    const session = { async query() { return [[{}]]; } };
    const agent = createRowAnalysisAgent(fakeSettings, { model });

    const stream = await agent.stream("分析当前记录", {
      requestContext: ctxWith(session, selectedRowContext),
    });
    await stream.text;

    const prompt = JSON.stringify(modelCalls[0]?.prompt);
    expect(prompt).toContain("通用记录分析");
    expect(prompt).not.toContain("领域背景");
  });

  test("模板提示装配只发生在当前工作簿会话上：无 session 时不读库、直接通用", async () => {
    const modelCalls: ModelCall[] = [];
    const model = await createPromptCapturingModel(modelCalls);
    let queried = false;
    // 诱饵 session 故意不注入执行上下文：若实现误走了非调用者会话会立刻暴露
    const session = { async query() { queried = true; return [[{ row_analysis: { background: "不应出现" } }]]; } };
    void session;
    const requestContext = new RequestContext();
    // 有 userContext 但没有 surrealSession：instructions 必须静默回退通用
    requestContext.set(ROUTER_RUNTIME_KEY, { userContext: selectedRowContext });
    const agent = createRowAnalysisAgent(fakeSettings, { model });

    const stream = await agent.stream("分析当前记录", { requestContext });
    await stream.text;

    expect(queried).toBe(false);
    expect(JSON.stringify(modelCalls[0]?.prompt)).toContain("通用记录分析");
  });
});
