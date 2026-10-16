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

  for (const whitespace of ["\n\n", " \t\r\n", "\u00a0\u3000"]) {
    for (const reasoning of [false, true]) {
      test(`纯空白 ${JSON.stringify(whitespace)}，reasoning=${reasoning} → 契约无产出`, async () => {
        const chunks = [
          ...(reasoning ? reasoningOnlyChunks : []),
          { type: "text-delta", payload: { text: whitespace } },
        ];
        for (const noOutputText of [undefined, ROW_ANALYSIS_NO_PROPOSAL_TEXT]) {
          const out = await makeAgentExecutor(fakeStreamAgent(chunks), { noOutputText })({
            taskText: "分析当前记录",
            shared: { userContext: regressionContext, confirmed: {} },
          });
          expect(out.noOutput).toBe(reasoning ? "reasoning-only" : "empty");
          expect(out.text).toBe(noOutputText ?? "");
          expect(out.suspend).toBeUndefined();
        }
      });
    }
  }

  test("stream.text 兜底中的纯空白也归类无产出", async () => {
    const out = await makeAgentExecutor(fakeStreamAgent([], { text: " \n" }), {
      noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT,
    })({ taskText: "分析当前记录", shared: { userContext: regressionContext, confirmed: {} } });
    expect(out.noOutput).toBe("empty");
    expect(out.text).toBe(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
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

describe("agent executor — PG-1 诊断可观测性缺口（suspend 白名单 / dropped 说明 / 审计摘要）", () => {
  const navCall = (type: string): AiToolCallRecord => ({
    toolName: "go",
    result: { intent: { type, workbookId: "workbook:demo", label: "演示" } },
  });

  test("navigation 类 intent 不再 suspend：前端无确认卡，run 走文本收尾", () => {
    for (const type of ["navigate", "open-workbook", "open-dashboard", "open-record"]) {
      expect(deriveSuspendSignalFromToolCalls([navCall(type)])).toBeUndefined();
    }
  });

  test("resource-draft / rowPatch / legacy dashboardDraft 不再 suspend", () => {
    expect(deriveSuspendSignalFromToolCalls([{
      toolName: "createResourceDraftIntent",
      result: { intent: { type: "resource-draft", draft: {} } },
    }])).toBeUndefined();
    expect(deriveSuspendSignalFromToolCalls([{
      toolName: "applyPatch",
      result: { intent: { type: "rowPatch", sheetId: "s", rowId: "r", patch: {} } },
    }])).toBeUndefined();
    expect(deriveSuspendSignalFromToolCalls([{
      toolName: "generateDashboardDraft",
      result: { intent: { type: "dashboardDraft", draft: { title: "T" } } },
    }])).toBeUndefined();
  });

  test("白名单 intent 仍 suspend：ambiguous / 非空提案 / dashboard-draft", () => {
    expect(deriveSuspendSignalFromToolCalls([{
      toolName: "searchRecord",
      result: { intent: { type: "ambiguous", candidates: [{ id: "r:1", label: "一" }] } },
    }])?.kind).toBe("ambiguous");
    expect(deriveSuspendSignalFromToolCalls([{
      toolName: "analyzeRow",
      result: { intent: { type: "row-patch-proposal", sheetId: "s", recordId: "r",
        proposals: [{ field: "f", currentValue: 1, suggestedValue: 2, basis: "b", confidence: "high" }] } },
    }])?.kind).toBe("await-write-confirm");
  });

  test("summarizeToolCallForAudit：只记形状不记业务值", async () => {
    const { summarizeToolCallForAudit } = await import("./agent-executor");
    const summary = summarizeToolCallForAudit({
      toolName: "analyzeRow",
      args: {
        sheetId: "sheet:devices",
        values: { check_status: "待复核", secret_note: "机密" },
        suggestions: [
          { field: "check_status", suggestedValue: "已复核", basis: "附件", confidence: "high" },
        ],
      },
      result: {
        intent: {
          type: "row-patch-proposal",
          sheetId: "sheet:devices",
          recordId: "ent_devices:pump-7",
          proposals: [{ field: "check_status", currentValue: "待复核", suggestedValue: "已复核", basis: "附件", confidence: "high" }],
          dropped: [{ field: "ghost", reason: "unknown-field" }],
        },
      },
    });
    expect(summary.toolName).toBe("analyzeRow");
    expect(summary.argShape).toContain("sheetId");
    expect(summary.argShape).toContain("suggestions[].field=check_status");
    expect(summary.argShape).toContain("values{keys…}");
    expect(summary.resultIntent).toBe("row-patch-proposal");
    expect(summary.proposalCount).toBe(1);
    expect(summary.droppedCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("已复核");
    expect(JSON.stringify(summary)).not.toContain("机密");
    expect(JSON.stringify(summary)).not.toContain("pump-7");
  });

  test("summarizeToolCallForAudit：无 intent 的纯查询调用只记工具名与参数形状", async () => {
    const { summarizeToolCallForAudit } = await import("./agent-executor");
    const summary = summarizeToolCallForAudit({
      toolName: "inspectSchema",
      args: { table: "ent_items" },
      result: { schemaSummary: { tables: ["ent_items"], fieldsByTable: { ent_items: ["name"] } } },
    });
    expect(summary).toEqual({ toolName: "inspectSchema", argShape: ["table"] });
  });

  test("deriveDroppedProposalNote：全丢弃才有说明；有存活提案或无丢弃返回 undefined", async () => {
    const { deriveDroppedProposalNote } = await import("./agent-executor");
    const full: AiToolCallRecord[] = [{
      toolName: "analyzeRow",
      result: { intent: { type: "row-patch-proposal", sheetId: "s", recordId: "r", proposals: [],
        dropped: [
          { field: "ghost", reason: "unknown-field" },
          { field: "金额", reason: "ambiguous-label" },
          { field: "created_at", reason: "non-editable" },
        ] } },
    }];
    const note = deriveDroppedProposalNote(full);
    expect(note).toContain("3 条字段建议均无法对应到数据表字段，已忽略");
    expect(note).toContain("ghost（未知字段）");
    expect(note).toContain("金额（名称歧义）");
    expect(note).toContain("created_at（不可编辑）");

    // 有存活提案：不打扰用户。
    expect(deriveDroppedProposalNote([{
      toolName: "analyzeRow",
      result: { intent: { type: "row-patch-proposal", sheetId: "s", recordId: "r",
        proposals: [{ field: "f", currentValue: 1, suggestedValue: 2, basis: "b", confidence: "high" }],
        dropped: [{ field: "ghost", reason: "unknown-field" }] } },
    }])).toBeUndefined();
    // 无提案 intent：与本函数无关。
    expect(deriveDroppedProposalNote([navCall("open-record")])).toBeUndefined();
    // 空列表。
    expect(deriveDroppedProposalNote([])).toBeUndefined();
  });

  test("executor 的 SubAgentInput.onToolCall 收到与 options.onToolCall 相同的 record", async () => {
    const { analyzeRowTool } = await import("../tools/row-analysis-tools");
    // @ts-expect-error @mastra/core 1.36.0 test-utils/llm-mock 缺少声明文件
    const { MastraLanguageModelV2Mock } = await import("@mastra/core/test-utils/llm-mock");
    const toolCallInput = {
      sheetId: "sheet:devices",
      recordId: "ent_devices:pump-7",
      values: { check_status: "待复核" },
      fields: [{ key: "check_status", label: "复核状态", fieldType: "select", options: ["待复核", "已复核"] }],
      suggestions: [
        { field: "check_status", suggestedValue: "已复核", basis: "超期", confidence: "medium" },
      ],
    };
    let probeCallCount = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        probeCallCount += 1;
        const chunks = probeCallCount === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call-9", toolName: "analyzeRow", input: JSON.stringify(toolCallInput) },
              { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
            ];
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      },
    });
    const agent = new Agent({
      name: "on-tool-call-probe",
      instructions: "调用 analyzeRow。",
      model,
      tools: { analyzeRow: analyzeRowTool },
    });
    const viaOptions: AiToolCallRecord[] = [];
    const viaInput: AiToolCallRecord[] = [];
    const executor = makeAgentExecutor(agent, { onToolCall: (record) => viaOptions.push(record) });
    await executor({
      taskText: "分析当前记录",
      shared: { userContext, confirmed: {} },
      onToolCall: (record) => viaInput.push(record),
    });
    expect(viaInput).toHaveLength(1);
    expect(viaOptions).toHaveLength(1);
    expect(viaInput[0]).toEqual(viaOptions[0]);
    expect(viaInput[0]?.toolName).toBe("analyzeRow");
  });

  test("全丢弃 + 无可见文本：dropped 说明拼接到 noOutputText 之后", async () => {
    const { analyzeRowTool } = await import("../tools/row-analysis-tools");
    // @ts-expect-error @mastra/core 1.36.0 test-utils/llm-mock 缺少声明文件
    const { MastraLanguageModelV2Mock } = await import("@mastra/core/test-utils/llm-mock");
    const toolCallInput = {
      sheetId: "sheet:devices",
      recordId: "ent_devices:pump-7",
      values: { check_status: "待复核" },
      fields: [{ key: "check_status", label: "复核状态", fieldType: "select", options: ["待复核", "已复核"] }],
      suggestions: [
        { field: "不存在的字段", suggestedValue: "x", basis: "臆测", confidence: "low" },
      ],
    };
    let callCount = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "tool-call", toolCallId: "call-drop", toolName: "analyzeRow", input: JSON.stringify(toolCallInput) });
                controller.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
                controller.close();
              },
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
            warnings: [],
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
              controller.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      },
    });
    const agent = new Agent({
      name: "all-dropped-probe",
      instructions: "调用 analyzeRow。",
      model,
      tools: { analyzeRow: analyzeRowTool },
    });
    const executor = makeAgentExecutor(agent, { noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT });
    const out = await executor({
      taskText: "分析当前记录",
      shared: { userContext, confirmed: {} },
    });
    expect(out.suspend).toBeUndefined();
    expect(out.text).toContain(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
    expect(out.text).toContain("不存在的字段（未知字段）");
    expect(out.text).not.toContain("等待确认");
  });
});
