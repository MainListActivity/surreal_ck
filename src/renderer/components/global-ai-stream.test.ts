import { describe, expect, test } from "bun:test";
import type { AiChatMessage } from "../../shared/ai-context";
import { applyAiChunkToMessages, type AiStreamState } from "./global-ai-stream";

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
});
