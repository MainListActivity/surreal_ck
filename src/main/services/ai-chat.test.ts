import { describe, expect, test } from "bun:test";
import { SendAiMessageRequestSchema, SendAiMessageResponseSchema } from "../../shared/rpc.types";

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
});

