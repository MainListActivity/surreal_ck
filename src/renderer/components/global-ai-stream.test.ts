import { describe, expect, test } from "bun:test";
import type { AiChatMessage } from "../../shared/ai-context";
import { applyAiChunkToMessages, buildRowPatchIntentFromProposal, type AiStreamState } from "./global-ai-stream";

function baseState(messages: AiChatMessage[]): AiStreamState {
  return {
    messages,
    pendingIntents: [],
    sending: true,
    sendError: null,
    streamedText: "",
  };
}

describe("applyAiChunkToMessages", () => {
  test("流式错误且没有任何 delta 时移除空白 assistant placeholder", () => {
    const placeholder: AiChatMessage = {
      id: "placeholder",
      role: "assistant",
      content: "",
      createdAt: "2026-05-10T00:00:00.000Z",
      context: { route: { screen: "editor" } },
    };

    const next = applyAiChunkToMessages(baseState([placeholder]), "placeholder", {
      streamId: "stream-1",
      type: "error",
      message: "模型请求失败",
    });

    expect(next.messages).toHaveLength(0);
    expect(next.sending).toBe(false);
    expect(next.sendError).toBe("模型请求失败");
  });

  test("流式错误但已有 delta 时保留已显示内容", () => {
    const placeholder: AiChatMessage = {
      id: "placeholder",
      role: "assistant",
      content: "已经生成的内容",
      createdAt: "2026-05-10T00:00:00.000Z",
      context: { route: { screen: "editor" } },
    };

    const state = baseState([placeholder]);
    state.streamedText = placeholder.content;

    const next = applyAiChunkToMessages(state, "placeholder", {
      streamId: "stream-1",
      type: "error",
      message: "连接中断",
    });

    expect(next.messages).toEqual([placeholder]);
    expect(next.sendError).toBe("连接中断");
  });

  test("done 事件携带 dashboard-draft tool result 时加入待确认意图", () => {
    const placeholder: AiChatMessage = {
      id: "placeholder",
      role: "assistant",
      content: "",
      createdAt: "2026-05-10T00:00:00.000Z",
      context: { route: { screen: "dashboard" } },
    };
    const finalMessage: AiChatMessage = { ...placeholder, id: "assistant-1", content: "已生成草稿。" };

    const next = applyAiChunkToMessages(baseState([placeholder]), "placeholder", {
      streamId: "stream-1",
      type: "done",
      message: finalMessage,
      toolCalls: [
        {
          toolName: "generateDashboardDraft",
          result: {
            intent: {
              type: "dashboard-draft",
              title: "债权申报金额月趋势",
              description: "按月统计债权申报金额趋势",
              explanation: "按月汇总申报金额。",
              widgetSpec: {
                sourceTables: ["ent_claim"],
                baseTable: "ent_claim",
                metric: { op: "sum", field: "declared_amount" },
                dimensions: [{ field: "submitted_at", bucket: "month" }],
              },
              draft: {
                workspaceId: "workspace:demo",
                title: "债权申报金额月趋势",
                queryMode: "builder",
                viewType: "line",
                resultContract: "time_series",
                builderSpec: {
                  sourceTables: ["ent_claim"],
                  baseTable: "ent_claim",
                  metric: { op: "sum", field: "declared_amount" },
                  dimensions: [{ field: "submitted_at", bucket: "month" }],
                },
              },
            },
          },
        },
      ],
    });

    expect(next.pendingIntents).toHaveLength(1);
    expect(next.pendingIntents[0].messageId).toBe("assistant-1");
    expect(next.pendingIntents[0].intent.type).toBe("dashboard-draft");
  });

  test("done 事件携带 row-patch-proposal tool result 时加入待确认意图", () => {
    const placeholder: AiChatMessage = {
      id: "placeholder",
      role: "assistant",
      content: "",
      createdAt: "2026-05-10T00:00:00.000Z",
      context: { route: { screen: "editor" } },
    };
    const finalMessage: AiChatMessage = { ...placeholder, id: "assistant-claim", content: "已生成补全建议。" };

    const next = applyAiChunkToMessages(baseState([placeholder]), "placeholder", {
      streamId: "stream-1",
      type: "done",
      message: finalMessage,
      toolCalls: [
        {
          toolName: "analyzeClaimRow",
          result: {
            intent: {
              type: "row-patch-proposal",
              sheetId: "sheet:claims",
              recordId: "ent_claim:abc",
              proposals: [
                {
                  field: "creditor_name",
                  currentValue: "",
                  suggestedValue: "张三",
                  basis: "申请书抬头",
                  confidence: "high",
                },
              ],
            },
          },
        },
      ],
    });

    expect(next.pendingIntents).toHaveLength(1);
    expect(next.pendingIntents[0].messageId).toBe("assistant-claim");
    expect(next.pendingIntents[0].intent.type).toBe("row-patch-proposal");
  });
});

describe("buildRowPatchIntentFromProposal", () => {
  test("只把已接受字段转换为 rowPatch 写入意图", () => {
    const intent = buildRowPatchIntentFromProposal(
      {
        type: "row-patch-proposal",
        sheetId: "sheet:claims",
        recordId: "ent_claim:abc",
        proposals: [
          {
            field: "creditor_name",
            currentValue: "",
            suggestedValue: "张三",
            basis: "申请书抬头",
            confidence: "high",
          },
          {
            field: "claim_amount",
            currentValue: 1000,
            suggestedValue: 1200,
            basis: "明细合计",
            confidence: "medium",
          },
        ],
      },
      new Set(["claim_amount"]),
    );

    expect(intent).toEqual({
      type: "rowPatch",
      sheetId: "sheet:claims",
      rowId: "ent_claim:abc",
      patch: { claim_amount: 1200 },
    });
  });
});
