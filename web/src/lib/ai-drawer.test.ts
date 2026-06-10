import { describe, expect, test } from "bun:test";
import type { AiChatMessage, AiContextSnapshot } from "@surreal-ck/shared";
import type { ChatStreamEvent, ResumeDecision } from "@surreal-ck/shared";
import { createAiDrawerSession, type AiDrawerStreamHandle } from "./ai-drawer";

function context(workspaceSlug = "acme"): AiContextSnapshot & { workspaceSlug: string } {
  return {
    workspaceSlug,
    route: { screen: "workspace" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "当前在工作区",
  };
}

function assistantMessage(content: string, contextSnapshot = context()): AiChatMessage {
  return {
    id: "assistant-final",
    role: "assistant",
    content,
    createdAt: "2026-06-10T00:00:00.000Z",
    context: contextSnapshot,
    citations: [
      {
        index: 1,
        resourceId: "resource_item:one",
        title: "资料一",
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const start = deferred<{ runId: string; streamUrl: string; streamToken: string }>();
  const starts: Array<{ message: string; contextSnapshot?: AiContextSnapshot }> = [];
  const resumes: Array<{ runId: string; decision: ResumeDecision }> = [];
  const handles: AiDrawerStreamHandle[] = [];
  const streamListeners: Array<(event: ChatStreamEvent) => void> = [];

  const session = createAiDrawerSession({
    chatClient: {
      startChat(input) {
        starts.push(input);
        return start.promise;
      },
      async resumeChat(runId, decision) {
        resumes.push({ runId, decision });
        return { runId, streamUrl: `/api/chat/stream?runId=${runId}`, streamToken: "resume-token" };
      },
    },
    connectStream(input) {
      streamListeners.push(input.onEvent);
      const handle: AiDrawerStreamHandle = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      handles.push(handle);
      return handle;
    },
    createId: (() => {
      let i = 0;
      return () => `id-${++i}`;
    })(),
    now: () => "2026-06-10T00:00:00.000Z",
  });

  return {
    session,
    start,
    starts,
    resumes,
    handles,
    emit(event: ChatStreamEvent, index = 0) {
      streamListeners[index]?.(event);
    },
  };
}

describe("AI 抽屉会话", () => {
  test("发送消息后立即显示路由提示，随后渲染 chunk 和最终带 citations 的消息", async () => {
    const h = harness();

    const sending = h.session.sendMessage("打开工作簿 X", context());

    expect(h.session.snapshot().progressHint).toBe("路由中…");
    expect(h.session.snapshot().sending).toBe(true);
    expect(h.session.snapshot().messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "打开工作簿 X"],
      ["assistant", ""],
    ]);
    expect(h.starts).toEqual([{ message: "打开工作簿 X", contextSnapshot: context() }]);

    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    expect(h.session.snapshot().activeRun?.runId).toBe("run-1");
    h.emit({ kind: "chunk", runId: "run-1", text: "正在" });
    h.emit({ kind: "chunk", runId: "run-1", text: "打开" });
    expect(h.session.snapshot().messages[1]?.content).toBe("正在打开");

    h.emit({ kind: "done", runId: "run-1", message: assistantMessage("已打开工作簿 X"), toolCalls: [] });

    const state = h.session.snapshot();
    expect(state.sending).toBe(false);
    expect(state.progressHint).toBeNull();
    expect(state.activeRun).toBeNull();
    expect(state.messages[1]).toMatchObject({
      id: "assistant-final",
      role: "assistant",
      content: "已打开工作簿 X",
      citations: [{ index: 1, title: "资料一" }],
    });
  });

  test("suspend 候选选择后调用 resume，并用新 streamToken 继续到 done", async () => {
    const h = harness();

    const sending = h.session.sendMessage("打开工作簿 X", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: {
        kind: "ambiguous-candidates",
        runId: "run-1",
        candidates: [
          { id: "workbook:alpha", label: "Alpha" },
          { id: "workbook:beta", label: "Beta" },
        ],
      },
    });

    const suspended = h.session.snapshot();
    expect(suspended.sending).toBe(false);
    expect(suspended.progressHint).toBeNull();
    expect(suspended.pendingIntents).toEqual([
      {
        messageId: "id-2",
        runId: "run-1",
        kind: "ambiguous-candidates",
        candidates: [
          { id: "workbook:alpha", label: "Alpha" },
          { id: "workbook:beta", label: "Beta" },
        ],
        dismissed: false,
      },
    ]);
    expect(h.handles[0]?.closed).toBe(true);

    await h.session.chooseCandidate("id-2", "workbook:beta");

    expect(h.resumes).toEqual([
      { runId: "run-1", decision: { kind: "candidate-chosen", candidateId: "workbook:beta" } },
    ]);
    expect(h.session.snapshot().progressHint).toBe("路由中…");
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(true);
    expect(h.handles).toHaveLength(2);

    h.emit({ kind: "done", runId: "run-1", message: assistantMessage("已打开 Beta"), toolCalls: [] }, 1);

    const done = h.session.snapshot();
    expect(done.sending).toBe(false);
    expect(done.activeRun).toBeNull();
    expect(done.messages[1]?.content).toBe("已打开 Beta");
  });

  test("workspace 切换时主动关闭未完成的 chat stream", async () => {
    const h = harness();

    const sending = h.session.sendMessage("打开工作簿 X", context("acme"));
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    h.session.syncWorkspace("acme");
    expect(h.handles[0]?.closed).toBe(false);
    expect(h.session.snapshot().activeRun?.runId).toBe("run-1");

    h.session.syncWorkspace("beta");

    const state = h.session.snapshot();
    expect(h.handles[0]?.closed).toBe(true);
    expect(state.workspaceSlug).toBe("beta");
    expect(state.activeRun).toBeNull();
    expect(state.sending).toBe(false);
    expect(state.progressHint).toBeNull();
  });
});
