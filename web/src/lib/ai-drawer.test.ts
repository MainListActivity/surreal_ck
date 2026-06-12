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

function harness(over: {
  resumeChat?: (runId: string, decision: ResumeDecision) => Promise<{ runId: string; streamUrl: string; streamToken: string }>;
} = {}) {
  const start = deferred<{ runId: string; streamUrl: string; streamToken: string }>();
  const starts: Array<{ message: string; contextSnapshot?: AiContextSnapshot; composerMode?: "chat" | "resource-search" }> = [];
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
        if (over.resumeChat) return over.resumeChat(runId, decision);
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

  test("composer「搜索资源」模式：startChat 带 composerMode=resource-search（确定性进资源检索）", async () => {
    const h = harness();

    const sending = h.session.sendMessage("合同解除案例", context(), { composerMode: "resource-search" });

    expect(h.starts).toEqual([
      { message: "合同解除案例", contextSnapshot: context(), composerMode: "resource-search" },
    ]);

    h.start.resolve({ runId: "run-rs", streamUrl: "/api/chat/stream?runId=run-rs", streamToken: "t" });
    await sending;
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

  test("suspend await-write-confirm 携带 row-patch-proposal 时，pending intent 带上提案供卡片渲染", async () => {
    const h = harness();

    const sending = h.session.sendMessage("分析这行债权", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    const proposal = {
      type: "row-patch-proposal" as const,
      sheetId: "sheet:claims",
      recordId: "ent_claim:one",
      proposals: [
        { field: "amount", currentValue: 100, suggestedValue: 250, basis: "依据合同附件二", confidence: "high" as const },
      ],
    };
    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: { kind: "await-write-confirm", runId: "run-1", intent: proposal },
    });

    const state = h.session.snapshot();
    expect(state.sending).toBe(false);
    expect(state.pendingIntents).toEqual([
      {
        messageId: "id-2",
        runId: "run-1",
        kind: "await-write-confirm",
        proposal,
        dismissed: false,
      },
    ]);
  });

  test("suspend await-write-confirm 携带 dashboard-draft 时，pending intent 带上草稿供卡片渲染", async () => {
    const h = harness();

    const sending = h.session.sendMessage("根据当前数据创建统计图表", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    const widgetSpec = {
      sourceTables: ["ent_claim"],
      baseTable: "ent_claim",
      metric: { op: "sum" as const, field: "amount" },
      dimensions: [{ field: "declared_at", bucket: "month" as const }],
      limit: 24,
    };
    const draftIntent = {
      type: "dashboard-draft" as const,
      title: "申报金额月趋势",
      description: "按月统计债权申报金额",
      widgetSpec,
      draft: {
        workspaceId: "workspace:main",
        title: "申报金额月趋势",
        queryMode: "builder" as const,
        viewType: "line" as const,
        resultContract: "time_series" as const,
        builderSpec: widgetSpec,
        status: "draft" as const,
      },
      explanation: "基于债权表，按月对申报金额求和。",
    };
    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: { kind: "await-write-confirm", runId: "run-1", intent: draftIntent },
    });

    const state = h.session.snapshot();
    expect(state.sending).toBe(false);
    expect(state.pendingIntents).toEqual([
      {
        messageId: "id-2",
        runId: "run-1",
        kind: "await-write-confirm",
        dashboardDraft: draftIntent,
        dismissed: false,
      },
    ]);
  });

  test("resumeWrite 成功：dismiss 提案卡、按 decision resume 并重连 stream 直到 done", async () => {
    const h = harness();

    const sending = h.session.sendMessage("分析这行债权", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;
    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: {
        kind: "await-write-confirm",
        runId: "run-1",
        intent: {
          type: "row-patch-proposal",
          sheetId: "sheet:claims",
          recordId: "ent_claim:one",
          proposals: [],
        },
      },
    });

    await h.session.resumeWrite("id-2", "write-confirmed");

    expect(h.resumes).toEqual([{ runId: "run-1", decision: { kind: "write-confirmed" } }]);
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(true);
    expect(h.handles).toHaveLength(2);

    h.emit({ kind: "done", runId: "run-1", message: assistantMessage("已写入 1 个字段"), toolCalls: [] }, 1);

    const done = h.session.snapshot();
    expect(done.sending).toBe(false);
    expect(done.activeRun).toBeNull();
    expect(done.messages[1]?.content).toBe("已写入 1 个字段");
  });

  test("resumeWrite 失败：错误上抛、提案卡保留（不 dismiss）、sending 复位", async () => {
    const h = harness({
      resumeChat: async () => {
        throw new Error("AI 会话续跑失败。");
      },
    });

    const sending = h.session.sendMessage("分析这行债权", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;
    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: {
        kind: "await-write-confirm",
        runId: "run-1",
        intent: {
          type: "row-patch-proposal",
          sheetId: "sheet:claims",
          recordId: "ent_claim:one",
          proposals: [],
        },
      },
    });

    await expect(h.session.resumeWrite("id-2", "write-rejected")).rejects.toThrow("AI 会话续跑失败。");

    const state = h.session.snapshot();
    expect(state.pendingIntents[0]?.dismissed).toBe(false);
    expect(state.sending).toBe(false);
    expect(state.progressHint).toBeNull();
  });

  test("suspend manual-research：pending intent 携带检索会话上下文，驱动检索 panel 打开", async () => {
    const h = harness();

    const sending = h.session.sendMessage("查相似案例", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: {
        kind: "manual-research",
        runId: "run-1",
        sessionId: "research_session:s1",
        workspaceId: "ws_demo",
        query: "查相似案例",
        resourceType: "generic_note",
      },
    });

    const state = h.session.snapshot();
    expect(state.sending).toBe(false);
    expect(state.pendingIntents).toEqual([
      {
        messageId: "id-2",
        runId: "run-1",
        kind: "manual-research",
        research: { sessionId: "research_session:s1", query: "查相似案例", resourceType: "generic_note" },
        dismissed: false,
      },
    ]);
    expect(state.messages[1]?.content).toContain("人工检索");
  });

  test("finishResearch：用全部已保存资源 id resume；成功才 dismiss 检索卡", async () => {
    const h = harness();

    const sending = h.session.sendMessage("查相似案例", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;
    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: {
        kind: "manual-research",
        runId: "run-1",
        sessionId: "research_session:s1",
        workspaceId: "ws_demo",
        query: "查相似案例",
        resourceType: "generic_note",
      },
    });

    await h.session.finishResearch("id-2", ["resource_item:r1", "resource_item:r2"]);

    expect(h.resumes).toEqual([
      {
        runId: "run-1",
        decision: { kind: "manual-research-completed", resourceIds: ["resource_item:r1", "resource_item:r2"] },
      },
    ]);
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(true);
    expect(h.handles).toHaveLength(2);
  });

  test("finishResearch 失败：错误上抛、检索卡保留（不 dismiss）", async () => {
    const h = harness({
      resumeChat: async () => {
        throw new Error("resume 失败");
      },
    });

    const sending = h.session.sendMessage("查相似案例", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;
    h.emit({
      kind: "suspend",
      runId: "run-1",
      payload: {
        kind: "manual-research",
        runId: "run-1",
        sessionId: "research_session:s1",
        workspaceId: "ws_demo",
        query: "查相似案例",
        resourceType: "generic_note",
      },
    });

    await expect(h.session.finishResearch("id-2", ["resource_item:r1"])).rejects.toThrow("resume 失败");
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(false);
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
