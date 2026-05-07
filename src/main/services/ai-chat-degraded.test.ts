import { describe, expect, test } from "bun:test";
import { buildDegradedResponse } from "./ai-chat";

// 降级响应是纯函数，无需 mock 任何模块

describe("buildDegradedResponse（无 API key 降级路径）", () => {
  const context = {
    route: { screen: "editor" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "当前在表格工作簿",
  };

  const req = {
    message: {
      id: "msg-1",
      role: "user" as const,
      content: "test",
      createdAt: new Date().toISOString(),
      context,
    },
    streamId: "stream-1",
  };

  test("返回 assistant 角色消息", () => {
    const result = buildDegradedResponse(req, "请先在设置中配置 AI API Key，才能使用 AI 功能。");
    expect(result.message.role).toBe("assistant");
    expect(result.message.content).toMatch(/API Key|配置/);
    expect(result.toolCalls).toEqual([]);
  });

  test("返回消息的 context 与入参一致", () => {
    const result = buildDegradedResponse(req, "需要配置 API Key");
    expect(result.message.context).toEqual(context);
  });
});
