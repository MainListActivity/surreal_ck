import { describe, expect, test } from "bun:test";
import { ExecuteAiActionRequestSchema, SendAiMessageRequestSchema, SendAiMessageResponseSchema } from "../../shared/rpc.types";
import { buildHistoryMessages } from "./ai-chat";

// ─── 切片 1：Zod schema 解析 ──────────────────────────────────────────────────

describe("ai.chat Zod schema 解析", () => {
  const validContext = {
    route: { screen: "editor" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "当前在表格工作簿",
  };

  const validMessage = {
    id: "msg-1",
    role: "user",
    content: "帮我分析这些数据",
    createdAt: new Date().toISOString(),
    context: validContext,
  };

  test("SendAiMessageRequestSchema 解析合法入参", () => {
    const input = { message: validMessage, streamId: "stream-abc" };
    const result = SendAiMessageRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("SendAiMessageRequestSchema 拒绝缺少 streamId 的入参", () => {
    const input = { message: validMessage };
    const result = SendAiMessageRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("SendAiMessageRequestSchema 拒绝 role 不合法的消息", () => {
    const input = {
      message: { ...validMessage, role: "system" },
      streamId: "stream-abc",
    };
    const result = SendAiMessageRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("SendAiMessageResponseSchema 解析合法返回值", () => {
    const output = {
      message: { ...validMessage, role: "assistant" },
      toolCalls: [],
    };
    const result = SendAiMessageResponseSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  test("SendAiMessageResponseSchema 解析带 toolCalls 的返回值", () => {
    const output = {
      message: { ...validMessage, role: "assistant" },
      toolCalls: [{ toolName: "navigate", args: { screen: "dashboard" }, result: null }],
    };
    const result = SendAiMessageResponseSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  test("SendAiMessageRequestSchema 解析含 history 的入参", () => {
    const input = {
      message: validMessage,
      streamId: "stream-abc",
      history: [
        { ...validMessage, id: "msg-0", role: "user", content: "打开工作簿债权表" },
        { ...validMessage, id: "msg-0r", role: "assistant", content: "已找到工作簿，请确认" },
      ],
    };
    const result = SendAiMessageRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// ─── executeAiAction schema ──────────────────────────────────────────────────

describe("executeAiAction Zod schema 解析", () => {
  test("接受 searchWorkbook 返回的 open-workbook 导航意图", () => {
    const input = {
      intent: {
        type: "open-workbook",
        workbookId: "workbook:case",
        label: "债权工作簿",
      },
    };

    const result = ExecuteAiActionRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// ─── buildHistoryMessages ─────────────────────────────────────────────────────

describe("buildHistoryMessages", () => {
  const ctx = {
    route: { screen: "home" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "当前在应用首页",
  };

  test("空历史返回空数组", () => {
    expect(buildHistoryMessages([])).toEqual([]);
  });

  test("user 消息转成带上下文的 user CoreMessage", () => {
    const msgs = [{ id: "1", role: "user" as const, content: "你好", createdAt: "", context: ctx }];
    const result = buildHistoryMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect((result[0].content as string)).toContain("你好");
  });

  test("assistant 消息转成 assistant CoreMessage，不附上下文", () => {
    const msgs = [{ id: "2", role: "assistant" as const, content: "已找到", createdAt: "", context: ctx }];
    const result = buildHistoryMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("已找到");
  });

  test("交替对话历史保持顺序", () => {
    const msgs = [
      { id: "1", role: "user" as const, content: "打开债权表", createdAt: "", context: ctx },
      { id: "2", role: "assistant" as const, content: "已找到", createdAt: "", context: ctx },
      { id: "3", role: "user" as const, content: "确认", createdAt: "", context: ctx },
    ];
    const result = buildHistoryMessages(msgs);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
  });
});
