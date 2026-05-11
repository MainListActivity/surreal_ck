import { describe, expect, test } from "bun:test";
import {
  AiProgressEventSchema,
  ExecuteAiActionRequestSchema,
  SendAiMessageRequestSchema,
  SendAiMessageResponseSchema,
} from "../../shared/rpc.types";
import { buildHistoryMessages, buildPlanOverrideForComposerMode } from "./ai-chat";

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
      runId: "run_abc",
    };
    const result = SendAiMessageResponseSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  test("SendAiMessageResponseSchema 必须包含 runId（issue 011/012 resume 用）", () => {
    const output = {
      message: { ...validMessage, role: "assistant" },
      toolCalls: [],
    };
    const result = SendAiMessageResponseSchema.safeParse(output);
    expect(result.success).toBe(false);
  });

  test("SendAiMessageResponseSchema 解析带 toolCalls 的返回值", () => {
    const output = {
      message: { ...validMessage, role: "assistant" },
      toolCalls: [{ toolName: "navigate", args: { screen: "dashboard" }, result: null }],
      runId: "run_xyz",
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

  test("SendAiMessageRequestSchema 接受资源搜索 composer mode", () => {
    const input = {
      message: { ...validMessage, content: "查找合同解除相关资料" },
      streamId: "stream-resource",
      composerMode: "resource-search",
    };
    const result = SendAiMessageRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.success && result.data.composerMode).toBe("resource-search");
  });
});

// ─── ai.progressStream schema ────────────────────────────────────────────────

describe("AiProgressEventSchema 解析", () => {
  test("接受 tool-call 事件", () => {
    const event = { kind: "tool-call", runId: "run_1", toolId: "searchWorkbook" };
    expect(AiProgressEventSchema.safeParse(event).success).toBe(true);
  });

  test("接受 routing 事件（issue 011/012 预留）", () => {
    const event = { kind: "routing", runId: "run_1" };
    expect(AiProgressEventSchema.safeParse(event).success).toBe(true);
  });

  test("接受 agent-step 事件（issue 011/012 预留）", () => {
    const event = { kind: "agent-step", runId: "run_1", agentName: "navigationAgent", taskText: "查找工作簿" };
    expect(AiProgressEventSchema.safeParse(event).success).toBe(true);
  });

  test("拒绝缺少 runId 的事件", () => {
    const event = { kind: "tool-call", toolId: "searchWorkbook" };
    expect(AiProgressEventSchema.safeParse(event).success).toBe(false);
  });

  test("拒绝未知 kind", () => {
    const event = { kind: "unknown", runId: "run_1" };
    expect(AiProgressEventSchema.safeParse(event).success).toBe(false);
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

describe("buildPlanOverrideForComposerMode", () => {
  const validContext = {
    route: { screen: "editor" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "当前在表格工作簿",
  };

  const validMessage = {
    id: "msg-resource",
    role: "user" as const,
    content: "查找合同解除相关资料",
    createdAt: new Date().toISOString(),
    context: validContext,
  };

  test("资源搜索模式生成单步 resource-retrieval 计划", () => {
    expect(buildPlanOverrideForComposerMode({
      message: validMessage,
      streamId: "stream-resource",
      composerMode: "resource-search",
    })).toEqual([
      { category: "resource-retrieval", taskText: "查找合同解除相关资料" },
    ]);
  });

  test("普通发送模式不覆盖 Router 分类", () => {
    expect(buildPlanOverrideForComposerMode({
      message: validMessage,
      streamId: "stream-chat",
    })).toBeUndefined();
  });
});
