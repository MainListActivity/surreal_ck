import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import {
  deriveCitationsFromToolCalls,
  deriveConfirmedFromToolCalls,
  deriveSuspendSignalFromToolCalls,
  makeAgentExecutor,
} from "./agent-executor";
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
