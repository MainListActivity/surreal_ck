import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AiContextSnapshot, AiToolCallRecord } from "@surreal-ck/shared";
import { makeAgentExecutor } from "./agent-executor";
import {
  buildSupplementPrompt,
  explainSupplementMiss,
  explicitEditTargetValue,
  keepValueMatchedProposals,
  planExplicitEditProposal,
  REASON_VALUE_UNCLEAR,
  ROW_PROPOSAL_TOOL,
} from "./row-proposal-supplement";
import { ROW_ANALYSIS_NO_PROPOSAL_TEXT } from "../agents/row-analysis-agent";
import { analyzeRowTool } from "../tools/row-analysis-tools";

const EXPLICIT_TASK = "把冷却泵 7 号的复核状态填为「待复核」";
const LOCATE_INPUT = { sheetId: "sheet:devices", field: "设备名称", value: "冷却泵 7 号" };
const UNIQUE_MATCH = { id: "ent_devices:pump-7", values: { name: "冷却泵 7 号", check_status: "已复核" } };
const SECOND_MATCH = { id: "ent_devices:pump-8", values: { name: "冷却泵 8 号", check_status: "已复核" } };

const userContext: AiContextSnapshot = {
  route: { screen: "editor", workbookId: "workbook:inspection", sheetId: "sheet:devices" },
  workbook: { id: "workbook:inspection", name: "设备巡检台账" },
  sheet: { id: "sheet:devices", label: "设备", tableName: "ent_devices" },
  selectedRow: {
    id: "ent_devices:pump-7",
    label: "冷却泵 7 号",
    visibleValues: { last_checked_at: "2026-09-01", check_status: "已复核" },
  },
  contextHint: "设备 / 冷却泵 7 号",
};

type LocateMatch = { id: string; values: Record<string, unknown> };
type Suggestion = { field: string; suggestedValue: string };

/** 与真实 analyzeRow 入参同形；带 values/fields 时工具不读库，便于假模型驱动。 */
function analyzeInput(suggestions: Suggestion[]) {
  return {
    sheetId: "sheet:devices",
    recordId: "ent_devices:pump-7",
    values: { check_status: "已复核", created_at: "2026-09-01" },
    fields: [
      { key: "check_status", label: "复核状态", fieldType: "select", options: ["待复核", "已复核"] },
      { key: "created_at", label: "创建时间", fieldType: "date" },
    ],
    suggestions: suggestions.map((item) => ({ ...item, basis: "用户明确指定", confidence: "high" })),
  };
}

function intentCall(
  proposals: Array<{ field: string; currentValue: unknown; suggestedValue: unknown }>,
  dropped: Array<{ field: string; reason: string }> = [],
): AiToolCallRecord {
  return {
    toolName: "analyzeRow",
    result: {
      intent: {
        type: "row-patch-proposal",
        sheetId: "sheet:devices",
        recordId: "ent_devices:pump-7",
        proposals: proposals.map((item) => ({ ...item, basis: "用户明确指定", confidence: "high" })),
        ...(dropped.length > 0 ? { dropped } : {}),
      },
    },
  };
}

function proposalsOf(call: AiToolCallRecord): Array<Record<string, unknown>> {
  return (call.result as { intent: { proposals: Array<Record<string, unknown>> } }).intent.proposals;
}

function locateCall(matches: LocateMatch[], args: Record<string, unknown> = {}): AiToolCallRecord {
  return { toolName: "findRecords", args: { ...LOCATE_INPUT, ...args }, result: { matches } };
}

describe("explicitEditTargetValue：只认写入动词后的目标值", () => {
  for (const [text, value] of [
    ["把冷却泵 7 号的复核状态填为「待复核」", "待复核"],
    ["把状态改为待复核。", "待复核"],
    ["将复核状态设为 已复核", "已复核"],
    ["把复核状态设置为\"已复核\"", "已复核"],
  ] as const) {
    test(`${text} → ${value}`, () => {
      expect(explicitEditTargetValue(text)).toBe(value);
    });
  }

  test("普通提问不命中写入动词", () => {
    expect(explicitEditTargetValue("分析当前记录的巡检状态")).toBeUndefined();
  });

  for (const [text, value] of [
    ["把状态填为「已联系客户的负责人」", "已联系客户的负责人"],
    ["把状态填为「待复核，已确认」", "待复核，已确认"],
    ["把状态填为「待 复核」", "待 复核"],
    ["把状态填为“待复核”", "待复核"],
    ["把状态填为「 待复核 」", "待复核"],
  ] as const) {
    test(`引号内原样截取到配对右引号：${text} → ${value}`, () => {
      expect(explicitEditTargetValue(text)).toBe(value);
    });
  }

  for (const verb of [
    "改为", "改成", "填为", "填写为", "填成", "填入", "设为", "设定为", "设置为", "设成", "置为", "定为", "记为",
    "标记为", "标注为", "标为", "标成", "更新为", "修改为", "写成", "写为", "变更为", "变为", "变成", "换为", "换成", "调整为",
  ]) {
    test(`每个写入动词都能取到引号值：${verb}`, () => {
      expect(explicitEditTargetValue(`把状态${verb}「待复核」。`)).toBe("待复核");
    });
  }

  for (const text of ["把状态填为：「待复核」", "把状态填为:「待复核」", "把状态填为： 「待复核」"]) {
    test(`写入动词后允许一个冒号再接引号值：${text}`, () => {
      expect(explicitEditTargetValue(text)).toBe("待复核");
    });
  }

  for (const text of [
    "把复核状态设为什么比较合适？",
    "把状态改为待复核吗？",
    "把状态设为「待复核」吗？",
    "把状态改为已联系客户的负责人，只改这一行。",
    "把状态改为待复核，只改这一行。",
    "把状态填为「待复核",
    "把状态设为待复核，并把备注改为「已确认」",
    "把状态改为待复核吧。",
    "如果把状态改为待复核会怎样",
    "把状态改为待复核行不行",
    "为什么把状态改为待复核",
  ]) {
    test(`问句或无法完整界定的目标值不作写入值：${text}`, () => {
      expect(explicitEditTargetValue(text)).toBeUndefined();
    });
  }
});

describe("planExplicitEditProposal：判定是否补一次提案调用", () => {
  const readOnlyFetch: AiToolCallRecord = {
    toolName: "fetchRelatedRecords",
    result: { source: "related-records", items: [], citations: [] },
  };

  test("显式改字段 + 只读轮 + 唯一命中 → supplement", () => {
    expect(planExplicitEditProposal(EXPLICIT_TASK, [locateCall([UNIQUE_MATCH]), readOnlyFetch])).toEqual({
      kind: "supplement",
      sheetId: "sheet:devices",
      recordId: "ent_devices:pump-7",
      value: "待复核",
    });
  });

  test("非显式请求 → skip", () => {
    expect(planExplicitEditProposal("分析当前记录", [locateCall([UNIQUE_MATCH])])).toEqual({ kind: "skip" });
  });

  test("本轮已有写入类工具调用 → skip（不重复补）", () => {
    const write: AiToolCallRecord = { toolName: "proposeRecordWrite", result: {} };
    expect(planExplicitEditProposal(EXPLICIT_TASK, [locateCall([UNIQUE_MATCH]), write])).toEqual({ kind: "skip" });
  });

  test("没有定位调用 → skip", () => {
    expect(planExplicitEditProposal(EXPLICIT_TASK, [readOnlyFetch])).toEqual({ kind: "skip" });
  });

  test("未命中 → blocked 并给出未找到原因", () => {
    const plan = planExplicitEditProposal(EXPLICIT_TASK, [locateCall([])]);
    expect(plan).toMatchObject({ kind: "blocked" });
    expect(plan.kind === "blocked" && plan.reason).toContain("没有找到与目标行匹配的记录");
  });

  test("多条命中 → blocked 并给出不唯一原因", () => {
    const plan = planExplicitEditProposal(EXPLICIT_TASK, [locateCall([UNIQUE_MATCH, SECOND_MATCH])]);
    expect(plan.kind === "blocked" && plan.reason).toContain("命中 2 条");
  });

  test("limit=1 时唯一命中也无法证明唯一 → blocked", () => {
    const plan = planExplicitEditProposal(EXPLICIT_TASK, [locateCall([UNIQUE_MATCH], { limit: 1 })]);
    expect(plan.kind === "blocked" && plan.reason).toContain("无法确认目标行唯一");
  });

  test("目标值无法完整界定 → blocked 并说明须把目标值放进「」里，不补调用", () => {
    for (const text of ["把状态改为待复核，只改这一行。", "把状态改为已联系客户的负责人，只改这一行。"]) {
      expect(planExplicitEditProposal(text, [locateCall([UNIQUE_MATCH])])).toEqual({
        kind: "blocked",
        reason: REASON_VALUE_UNCLEAR,
      });
    }
  });

  test("问句不是写入请求 → skip", () => {
    expect(planExplicitEditProposal("把复核状态设为什么比较合适？", [locateCall([UNIQUE_MATCH])])).toEqual({ kind: "skip" });
  });

  test("引号内完整目标值 → supplement，值逐字保留", () => {
    expect(planExplicitEditProposal("把冷却泵 7 号的复核状态填为「待复核，已确认」", [locateCall([UNIQUE_MATCH])])).toEqual({
      kind: "supplement",
      sheetId: "sheet:devices",
      recordId: "ent_devices:pump-7",
      value: "待复核，已确认",
    });
  });
});

describe("keepValueMatchedProposals / explainSupplementMiss / buildSupplementPrompt", () => {
  test("只保留与目标值逐字一致的建议，原始记录不改写", () => {
    const call = intentCall([
      { field: "check_status", currentValue: "已复核", suggestedValue: "待复核" },
      { field: "remark", currentValue: "", suggestedValue: "其他" },
    ]);
    const kept = keepValueMatchedProposals(call, "待复核");
    expect(proposalsOf(kept)).toHaveLength(1);
    expect(proposalsOf(kept)[0]).toMatchObject({ field: "check_status", suggestedValue: "待复核" });
    expect(proposalsOf(call)).toHaveLength(2);
  });

  test("非提案调用原样返回", () => {
    const locate = locateCall([UNIQUE_MATCH]);
    expect(keepValueMatchedProposals(locate, "待复核")).toBe(locate);
  });

  test("未挂起原因：无提案 / 字段被丢弃 / 建议值不一致 三类区分", () => {
    expect(explainSupplementMiss([], "待复核")).toContain("没有为目标记录生成字段建议");
    expect(explainSupplementMiss([intentCall([], [{ field: "ghost", reason: "unknown-field" }])], "待复核"))
      .toContain("建议的字段未通过校验");
    expect(explainSupplementMiss([intentCall([{ field: "check_status", currentValue: "已复核", suggestedValue: "已复核" }])], "待复核"))
      .toContain("与您指定的「待复核」不一致");
  });

  test("补充提示词携带目标记录、目标值与唯一工具约束", () => {
    const prompt = buildSupplementPrompt("BASE", {
      kind: "supplement",
      sheetId: "sheet:devices",
      recordId: "ent_devices:pump-7",
      value: "待复核",
    });
    expect(prompt.startsWith("BASE\n")).toBe(true);
    expect(prompt).toContain("recordId=ent_devices:pump-7");
    expect(prompt).toContain("「待复核」");
    expect(prompt).toContain(ROW_PROPOSAL_TOOL);
    expect(prompt).toContain("workbookId");
  });
});

// ─── 假模型驱动的执行器集成：真实 agent.stream 链路，不调用任何生产模型 ─────────

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function toolTurn(toolCallId: string, toolName: string, input: unknown): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage },
  ];
}

function textTurn(text: string): unknown[] {
  const head = [{ type: "stream-start", warnings: [] }];
  if (!text) return [...head, { type: "finish", finishReason: "stop", usage }];
  return [
    ...head,
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ];
}

function streamOf(chunks: unknown[]) {
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
}

/** 按轮次回放脚本；calls 记录每次 doStream 收到的原始选项（工具集、toolChoice、提示词）。 */
async function scriptedModel(turns: unknown[][]) {
  // @ts-expect-error @mastra/core 1.36.0 test-utils/llm-mock 缺少声明文件
  const { MastraLanguageModelV2Mock } = await import("@mastra/core/test-utils/llm-mock");
  const calls: Record<string, unknown>[] = [];
  const model = new MastraLanguageModelV2Mock({
    doStream: async (options: Record<string, unknown>) => {
      calls.push(options);
      return streamOf(turns[calls.length - 1] ?? textTurn(""));
    },
  });
  return { model, calls };
}

function findRecordsStub(matches: LocateMatch[]) {
  return createTool({
    id: "findRecords",
    description: "测试桩：按字段值定位记录，返回形状与真实工具一致。",
    inputSchema: z.object({
      sheetId: z.string(),
      field: z.string(),
      value: z.string(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async () => ({ matches }),
  });
}

const fetchRelatedStub = createTool({
  id: "fetchRelatedRecords",
  description: "测试桩：当前记录没有关联资源。",
  inputSchema: z.object({ sheetId: z.string().optional(), recordId: z.string().optional() }),
  execute: async () => ({ source: "related-records", items: [], citations: [] }),
});

function rowAgent(name: string, model: ConstructorParameters<typeof Agent>[0]["model"], matches: LocateMatch[]) {
  return new Agent({
    id: name,
    name,
    instructions: "行分析测试桩：按脚本调用工具。",
    model,
    tools: {
      findRecords: findRecordsStub(matches),
      fetchRelatedRecords: fetchRelatedStub,
      analyzeRow: analyzeRowTool,
    },
  });
}

function toolNames(call: Record<string, unknown> | undefined): string[] {
  const tools = (call?.tools ?? []) as Array<{ name?: unknown }>;
  return tools.map((tool) => String(tool.name));
}

function run(executorOptions: Parameters<typeof makeAgentExecutor>[1], agent: Agent, taskText: string) {
  return makeAgentExecutor(agent, executorOptions)({ taskText, shared: { userContext, confirmed: {} } });
}

describe("row-analysis 显式改字段的补充提案（FV06）", () => {
  test("只读定位后同一请求内补一次强制 analyzeRow → 可确认 suspend（提案卡）", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
      toolTurn("c2", "analyzeRow", analyzeInput([{ field: "复核状态", suggestedValue: "待复核" }])),
    ]);
    const records: AiToolCallRecord[] = [];
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT, onToolCall: (r) => records.push(r) },
      rowAgent("fv06-positive", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(3);
    expect(calls[2]?.toolChoice).toEqual({ type: "tool", toolName: ROW_PROPOSAL_TOOL });
    expect(toolNames(calls[2])).toEqual([ROW_PROPOSAL_TOOL]);
    expect(JSON.stringify(calls[2]?.prompt)).toContain("recordId=ent_devices:pump-7");
    expect(records.map((r) => r.toolName)).toEqual(["findRecords", "analyzeRow"]);
    expect(out.text).not.toContain(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
    expect(out.suspend).toEqual({
      kind: "await-write-confirm",
      intent: {
        type: "row-patch-proposal",
        sheetId: "sheet:devices",
        recordId: "ent_devices:pump-7",
        proposals: [{
          field: "check_status",
          currentValue: "已复核",
          suggestedValue: "待复核",
          basis: "用户明确指定",
          confidence: "high",
        }],
      },
    });
  });

  test("生产形态：主轮 4 步只读工具耗尽（findRecords + fetchRelatedRecords×3）→ 仍补出提案卡", async () => {
    const related = { sheetId: "sheet:devices", recordId: "ent_devices:pump-7" };
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      toolTurn("c2", "fetchRelatedRecords", related),
      toolTurn("c3", "fetchRelatedRecords", related),
      toolTurn("c4", "fetchRelatedRecords", related),
      toolTurn("c5", "analyzeRow", analyzeInput([{ field: "复核状态", suggestedValue: "待复核" }])),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-exhausted", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(5);
    expect(calls[4]?.toolChoice).toEqual({ type: "tool", toolName: ROW_PROPOSAL_TOOL });
    expect(out.suspend?.kind).toBe("await-write-confirm");
    expect(out.text).not.toContain(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
  });

  test("引号内含逗号的完整目标值：提案卡建议值逐字等于用户原话", async () => {
    const taskText = "把冷却泵 7 号的复核状态填为「待复核，已确认」";
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
      toolTurn("c2", "analyzeRow", analyzeInput([{ field: "复核状态", suggestedValue: "待复核，已确认" }])),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-full-value", model, [UNIQUE_MATCH]),
      taskText,
    );

    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[2]?.prompt)).toContain("「待复核，已确认」");
    expect(out.suspend?.kind).toBe("await-write-confirm");
    expect(out.suspend).toMatchObject({
      intent: {
        type: "row-patch-proposal",
        proposals: [{ field: "check_status", currentValue: "已复核", suggestedValue: "待复核，已确认" }],
      },
    });
  });

  test("标记为：只读定位后同一请求内补一次强制 analyzeRow → 可确认 suspend（提案卡）", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
      toolTurn("c2", "analyzeRow", analyzeInput([{ field: "复核状态", suggestedValue: "待复核" }])),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-mark-as", model, [UNIQUE_MATCH]),
      "把冷却泵 7 号的复核状态标记为「待复核」",
    );

    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[2]?.prompt)).toContain("「待复核」");
    expect(out.suspend?.kind).toBe("await-write-confirm");
    expect(out.suspend).toMatchObject({
      intent: { type: "row-patch-proposal", proposals: [{ field: "check_status", suggestedValue: "待复核" }] },
    });
  });

  const blockedCases: Array<{
    name: string;
    matches: LocateMatch[];
    locate: Record<string, unknown>;
    reason: string;
    task?: string;
  }> = [
    { name: "未找到", matches: [], locate: LOCATE_INPUT, reason: "没有找到与目标行匹配的记录" },
    { name: "多条命中", matches: [UNIQUE_MATCH, SECOND_MATCH], locate: LOCATE_INPUT, reason: "命中 2 条" },
    { name: "limit=1 不能证明唯一", matches: [UNIQUE_MATCH], locate: { ...LOCATE_INPUT, limit: 1 }, reason: "无法确认目标行唯一" },
    {
      name: "目标值无法界定",
      matches: [UNIQUE_MATCH],
      locate: LOCATE_INPUT,
      reason: "请把目标值放进「」里",
      task: "把冷却泵 7 号的复核状态填为待复核，只改这一行。",
    },
  ];
  for (const item of blockedCases) {
    test(`${item.name}：不补调用、不挂起，以明确原因收尾`, async () => {
      const { model, calls } = await scriptedModel([
        toolTurn("c1", "findRecords", item.locate),
        textTurn(""),
      ]);
      const out = await run(
        { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
        rowAgent(`fv06-blocked-${item.name}`, model, item.matches),
        item.task ?? EXPLICIT_TASK,
      );

      expect(calls).toHaveLength(2);
      expect(out.suspend).toBeUndefined();
      expect(out.text.startsWith("未生成字段补全提案：")).toBe(true);
      expect(out.text).toContain(item.reason);
      expect(out.text).not.toBe(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
    });
  }

  test("补调用字段不可编辑：不挂起，说明字段被校验丢弃", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
      toolTurn("c2", "analyzeRow", analyzeInput([{ field: "创建时间", suggestedValue: "待复核" }])),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-non-editable", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(3);
    expect(out.suspend).toBeUndefined();
    expect(out.text).toContain("建议的字段未通过校验");
    expect(out.text).toContain("创建时间（不可编辑）");
  });

  test("补调用建议值与用户指定值不一致：不挂起，原始记录仍保留模型输出", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
      toolTurn("c2", "analyzeRow", analyzeInput([{ field: "复核状态", suggestedValue: "已复核" }])),
    ]);
    const records: AiToolCallRecord[] = [];
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT, onToolCall: (r) => records.push(r) },
      rowAgent("fv06-value-mismatch", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(3);
    expect(out.suspend).toBeUndefined();
    expect(out.text).toContain("与您指定的「待复核」不一致");
    const raw = records.find((r) => r.toolName === "analyzeRow");
    expect(proposalsOf(raw!)[0]).toMatchObject({ suggestedValue: "已复核" });
  });

  test("补调用模型未调用 analyzeRow：不挂起，说明没有给出字段建议", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
      textTurn("好的"),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-no-call", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(3);
    expect(out.suspend).toBeUndefined();
    expect(out.text).toContain("没有为目标记录生成字段建议");
  });

  test("非显式改字段的普通提问：不补调用，文本原样返回", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn("当前记录状态正常，无需修改。"),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-plain", model, [UNIQUE_MATCH]),
      "分析当前记录的巡检状态",
    );

    expect(calls).toHaveLength(2);
    expect(out.text).toBe("当前记录状态正常，无需修改。");
    expect(out.suspend).toBeUndefined();
  });

  test("未启用 ensureExplicitEditProposal：显式改字段也不补调用（历史行为不变）", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "findRecords", LOCATE_INPUT),
      textTurn(""),
    ]);
    const out = await run(
      { noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-disabled", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(2);
    expect(out.text).toBe(ROW_ANALYSIS_NO_PROPOSAL_TEXT);
    expect(out.noOutput).toBe("empty");
  });

  test("主轮已产出提案：不补调用，直接挂起", async () => {
    const { model, calls } = await scriptedModel([
      toolTurn("c1", "analyzeRow", analyzeInput([{ field: "复核状态", suggestedValue: "待复核" }])),
      textTurn("已生成提案"),
    ]);
    const out = await run(
      { ensureExplicitEditProposal: true, noOutputText: ROW_ANALYSIS_NO_PROPOSAL_TEXT },
      rowAgent("fv06-main-proposal", model, [UNIQUE_MATCH]),
      EXPLICIT_TASK,
    );

    expect(calls).toHaveLength(2);
    expect(out.suspend?.kind).toBe("await-write-confirm");
  });
});
