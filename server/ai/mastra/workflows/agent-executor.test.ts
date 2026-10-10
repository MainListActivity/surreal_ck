import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import {
  AgentStreamInterruptedError,
  deriveCitationsFromToolCalls,
  deriveConfirmedFromToolCalls,
  deriveSuspendSignalFromToolCalls,
  makeAgentExecutor,
} from "./agent-executor";
import { ROW_ANALYSIS_NO_PROPOSAL_TEXT } from "../agents/row-analysis-agent";
import { analyzeRowTool } from "../tools/row-analysis-tools";
import type { AiContextSnapshot, AiToolCallRecord } from "@surreal-ck/shared";

describe("agent executor tool result translation", () => {
  test("记录关联资源的工具结果透传为可点击 citations", () => {
    const citations = deriveCitationsFromToolCalls([{
      toolName: "fetchRelatedRecords",
      result: {
        source: "record-resources",
        items: [],
        citations: [{
          index: 1,
          resourceId: "resource_item:r1",
          title: "网页判例",
          sourceUrl: "https://example.test/case",
          evidence: [{ order: 0, text: "巡检记录显示该设备需要复检。" }],
        }],
      },
    }]);

    expect(citations).toEqual([{
      index: 1,
      resourceId: "resource_item:r1",
      title: "网页判例",
      sourceUrl: "https://example.test/case",
      evidence: [{ order: 0, text: "巡检记录显示该设备需要复检。" }],
    }]);
  });

  test("ambiguous tool intent becomes a workflow suspend signal", () => {
    const signal = deriveSuspendSignalFromToolCalls([
      {
        toolName: "searchRecord",
        result: {
          intent: {
            type: "ambiguous",
            candidates: [
              { id: "ent_items:1", label: "张三 / XJ-1" },
              { id: "ent_items:2", label: "张三 / XJ-2" },
            ],
          },
        },
      },
    ]);

    expect(signal).toEqual({
      kind: "ambiguous",
      candidates: [
        { id: "ent_items:1", label: "张三 / XJ-1" },
        { id: "ent_items:2", label: "张三 / XJ-2" },
      ],
    });
  });

  test("write-side tool intent becomes await-write-confirm", () => {
    const signal = deriveSuspendSignalFromToolCalls([
      {
        toolName: "generateDashboardDraft",
        result: {
          intent: {
            type: "dashboard-draft",
            title: "故障趋势",
            description: "按月统计故障",
            explanation: "按月汇总。",
            widgetSpec: {
              sourceTables: ["ent_items"],
              baseTable: "ent_items",
              metric: { op: "sum", field: "amount" },
            },
            draft: {
              workspaceId: "workspace:demo",
              title: "故障趋势",
              queryMode: "builder",
              viewType: "line",
              resultContract: "time_series",
              builderSpec: {
                sourceTables: ["ent_items"],
                baseTable: "ent_items",
                metric: { op: "sum", field: "amount" },
              },
            },
          },
        },
      },
    ]);

    expect(signal?.kind).toBe("await-write-confirm");
    expect(signal && "intent" in signal ? signal.intent.type : null).toBe("dashboard-draft");
  });

  test("空提案的 row-patch-proposal 不 suspend：无可确认字段不出卡片", () => {
    const signal = deriveSuspendSignalFromToolCalls([{
      toolName: "analyzeRow",
      result: {
        intent: {
          type: "row-patch-proposal",
          sheetId: "sheet:devices",
          recordId: "ent_devices:pump-7",
          proposals: [],
        },
      },
    }]);

    expect(signal).toBeUndefined();
  });

  test("空提案的 record-write-proposal 同样不 suspend", () => {
    const signal = deriveSuspendSignalFromToolCalls([{
      toolName: "proposeRecordWrite",
      result: {
        intent: {
          type: "record-write-proposal",
          operation: "create",
          sheetId: "sheet:devices",
          proposals: [],
        },
      },
    }]);

    expect(signal).toBeUndefined();
  });

  test("schema summary and resolved record are collected as confirmed context", () => {
    const calls: AiToolCallRecord[] = [
      {
        toolName: "inspectSchema",
        result: {
          schemaSummary: {
            tables: ["ent_items"],
            fieldsByTable: { ent_items: ["name", "amount"] },
          },
        },
      },
      {
        toolName: "searchRecord",
        result: {
          intent: {
            type: "open-record",
            workbookId: "workbook:demo",
            sheetId: "sheet:items",
            recordId: "ent_items:abc",
            label: "张三 / XJ-1",
          },
        },
      },
    ];

    expect(deriveConfirmedFromToolCalls(calls)).toEqual({
      schemaSummary: {
        tables: ["ent_items"],
        fieldsByTable: { ent_items: ["name", "amount"] },
      },
      resolvedRecord: { id: "ent_items:abc", label: "张三 / XJ-1" },
    });
  });
});

const userContext: AiContextSnapshot = {
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

describe("Mastra step chunk 形状回归（真实 agent.stream 链路）", () => {
  // Mastra 1.36 的 onStepFinish 收到的是 ChunkType 包装：
  // { type:'tool-result', payload:{ toolCallId, toolName, args, result } }。
  // 本测试用真模型流桩驱动真实 analyzeRow 工具，钉住「结果必须落到 record.result」，
  // 防止上游字段形状再漂移时 suspend/intent 静默丢失（CV05 线上零卡片根因）。
  test("analyzeRow 工具结果经 onStepFinish 转为 await-write-confirm suspend", async () => {
    // @ts-expect-error @mastra/core 1.36.0 test-utils/llm-mock 缺少声明文件
    const { MastraLanguageModelV2Mock } = await import("@mastra/core/test-utils/llm-mock");

    const toolCallInput = {
      sheetId: "sheet:devices",
      recordId: "ent_devices:pump-7",
      values: { last_checked_at: "2026-09-01", check_status: "待复核" },
      fields: [
        { key: "last_checked_at", label: "巡检日期", fieldType: "date" },
        { key: "check_status", label: "复核状态", fieldType: "select", options: ["待复核", "已复核"] },
      ],
      suggestions: [
        { field: "check_status", suggestedValue: "已复核", basis: "上次巡检已超 30 天", confidence: "medium" },
      ],
    };
    const modelStream = (chunks: unknown[]) => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
    });
    let callCount = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          return modelStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call-1", toolName: "analyzeRow", input: JSON.stringify(toolCallInput) },
            { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          ]);
        }
        return modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "已生成提案待确认" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
        ]);
      },
    });

    const agent = new Agent({
      name: "executor-shape-probe",
      instructions: "调用 analyzeRow 后用一句话总结。",
      model,
      tools: { analyzeRow: analyzeRowTool },
    });
    const records: AiToolCallRecord[] = [];
    const executor = makeAgentExecutor(agent, { onToolCall: (record) => records.push(record) });

    const out = await executor({
      taskText: "分析当前记录",
      shared: { userContext, confirmed: {} },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.toolName).toBe("analyzeRow");
    expect(records[0]?.args).toMatchObject({ recordId: "ent_devices:pump-7" });
    expect(records[0]?.result).toMatchObject({ intent: { type: "row-patch-proposal" } });
    expect(out.text).toBe("已生成提案待确认");
    expect(out.suspend).toEqual({
      kind: "await-write-confirm",
      intent: {
        type: "row-patch-proposal",
        sheetId: "sheet:devices",
        recordId: "ent_devices:pump-7",
        proposals: [{
          field: "check_status",
          currentValue: "待复核",
          suggestedValue: "已复核",
          basis: "上次巡检已超 30 天",
          confidence: "medium",
        }],
      },
    });
  });
});

// ─── def-row-analysis-no-proposal 回归：reasoning 模型空输出 / 流中断 ──────────

const regressionContext: AiContextSnapshot = {
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

/** 与 MastraModelOutput.fullStream 同形状（payload 包裹）的最小 fake agent。 */
function fakeStreamAgent(chunks: unknown[], extra: { error?: unknown; text?: string } = {}) {
  return {
    async stream() {
      return {
        fullStream: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
        text: Promise.resolve(extra.text ?? ""),
        error: extra.error,
      };
    },
  } as unknown as Agent;
}

const reasoningOnlyChunks = [
  { type: "reasoning-start", payload: { id: "r1" } },
  { type: "reasoning-delta", payload: { id: "r1", text: "用户在问巡检记录，我需要先看字段定义……" } },
  { type: "reasoning-end", payload: { id: "r1" } },
  { type: "finish", payload: { finishReason: "stop", usage: { inputTokens: 3611, outputTokens: 177, reasoningTokens: 177 } } },
];

describe("agent executor — reasoning 模型无可见产出走契约化显式态", () => {
  test("reasoning-only 输出（fv02-2 形态）→ noOutputText 显式收尾，不退化成空回复", async () => {
    const executor = makeAgentExecutor(fakeStreamAgent(reasoningOnlyChunks), {
      noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT,
    });

    const out = await executor({
      taskText: "分析当前记录",
      shared: { userContext: regressionContext, confirmed: {} },
    });

    expect(out.noOutput).toBe("reasoning-only");
    expect(out.text).toBe(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
    expect(out.text).not.toBe("");
    expect(out.deltas).toEqual([]);
    expect(out.suspend).toBeUndefined();
  });

  test("未配 noOutputText 时保持空串并上报归类（上游兜底责任不下沉）", async () => {
    const executor = makeAgentExecutor(fakeStreamAgent(reasoningOnlyChunks));

    const out = await executor({
      taskText: "分析当前记录",
      shared: { userContext: regressionContext, confirmed: {} },
    });

    expect(out.noOutput).toBe("reasoning-only");
    expect(out.text).toBe("");
  });

  test("推理后仍有可见文本时按正常回答收尾，不触发 no-proposal 契约", async () => {
    const executor = makeAgentExecutor(
      fakeStreamAgent([
        ...reasoningOnlyChunks.slice(0, 3),
        { type: "text-start", payload: { id: "t1" } },
        { type: "text-delta", payload: { id: "t1", text: "当前记录缺少巡检日期，" } },
        { type: "text-delta", payload: { id: "t1", text: "暂时无法生成补全建议。" } },
        { type: "text-end", payload: { id: "t1" } },
      ], { text: "当前记录缺少巡检日期，暂时无法生成补全建议。" }),
      { noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
    );

    const out = await executor({
      taskText: "分析当前记录",
      shared: { userContext: regressionContext, confirmed: {} },
    });

    expect(out.noOutput).toBeUndefined();
    expect(out.text).toBe("当前记录缺少巡检日期，暂时无法生成补全建议。");
    expect(out.deltas).toEqual(["当前记录缺少巡检日期，", "暂时无法生成补全建议。"]);
  });

  test("流中途错误（fv02-4 形态：部分文本后 error part）→ 抛 AgentStreamInterruptedError，不静默收尾", async () => {
    const executor = makeAgentExecutor(fakeStreamAgent([
      { type: "reasoning-start", payload: { id: "r1" } },
      { type: "reasoning-delta", payload: { id: "r1", text: "（长推理 3848 tokens）" } },
      { type: "reasoning-end", payload: { id: "r1" } },
      { type: "text-start", payload: { id: "t1" } },
      { type: "text-delta", payload: { id: "t1", text: "正在核对字段定义" } },
      { type: "error", payload: { error: new Error("internal-ai-provider-stream-failed") } },
    ]));

    const error = await executor({
      taskText: "分析当前记录",
      shared: { userContext: regressionContext, confirmed: {} },
    }).then(() => undefined, (err: unknown) => err);

    expect(error).toBeInstanceOf(AgentStreamInterruptedError);
    expect((error as AgentStreamInterruptedError).code).toBe("ai-stream-interrupted");
    expect((error as AgentStreamInterruptedError).message).toContain("生成流中断");
    expect(((error as AgentStreamInterruptedError).cause as Error).message)
      .toBe("internal-ai-provider-stream-failed");
  });

  test("空提案（模型显式传空 suggestions）→ 不 suspend、noOutput=empty、契约文案收尾", async () => {
    // @ts-expect-error @mastra/core 1.36.0 test-utils/llm-mock 缺少声明文件
    const { MastraLanguageModelV2Mock } = await import("@mastra/core/test-utils/llm-mock");
    const modelStream = (chunks: unknown[]) => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
    });
    let callCount = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        callCount += 1;
        // 第 1 步：显式传空 suggestions（模型明说没有可补全字段）；
        // 第 2 步：直接 stop 且不产出任何文本（fv02 生产形态的收尾）。
        if (callCount === 1) {
          return modelStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call-empty", toolName: "analyzeRow", input: JSON.stringify({
              sheetId: "sheet:devices",
              recordId: "ent_devices:pump-7",
              values: { last_checked_at: "2026-09-01", check_status: "待复核" },
              fields: [
                { key: "last_checked_at", label: "巡检日期", fieldType: "date" },
                { key: "check_status", label: "复核状态", fieldType: "select", options: ["待复核", "已复核"] },
              ],
              suggestions: [],
            }) },
            { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          ]);
        }
        return modelStream([
          { type: "stream-start", warnings: [] },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 } },
        ]);
      },
    });
    const agent = new Agent({
      name: "row-analysis-empty-proposal",
      instructions: "没有可补全字段时调用 analyzeRow 并传空 suggestions。",
      model,
      tools: { analyzeRow: analyzeRowTool },
    });
    const executor = makeAgentExecutor(agent, { noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT });

    const out = await executor({
      taskText: "分析当前记录",
      shared: { userContext: regressionContext, confirmed: {} },
    });

    // 空提案不出卡片（不伪造提案），但收尾必须是显式 no-proposal 态而不是空回复。
    expect(out.suspend).toBeUndefined();
    expect(out.noOutput).toBe("empty");
    expect(out.text).toBe(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
  });
});
