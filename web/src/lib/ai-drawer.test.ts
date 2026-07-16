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
  startChat?: (input: {
    message: string;
    contextSnapshot?: AiContextSnapshot;
    composerMode?: "chat" | "resource-search";
  }) => Promise<{ runId: string; streamUrl: string; streamToken: string }>;
  resumeChat?: (runId: string, decision: ResumeDecision) => Promise<{ runId: string; streamUrl: string; streamToken: string }>;
} = {}) {
  const start = deferred<{ runId: string; streamUrl: string; streamToken: string }>();
  const starts: Array<{ message: string; contextSnapshot?: AiContextSnapshot; composerMode?: "chat" | "resource-search" }> = [];
  const resumes: Array<{ runId: string; decision: ResumeDecision }> = [];
  const handles: AiDrawerStreamHandle[] = [];
  const streamListeners: Array<(event: ChatStreamEvent) => void> = [];
  const idleTimeoutListeners: Array<() => void> = [];
  const closeListeners: Array<(code: number) => void> = [];

  const session = createAiDrawerSession({
    chatClient: {
      startChat(input) {
        starts.push(input);
        if (over.startChat) return over.startChat(input);
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
      if (input.onIdleTimeout) idleTimeoutListeners.push(input.onIdleTimeout);
      if (input.onClose) closeListeners.push(input.onClose);
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
    timeout(index = 0) {
      idleTimeoutListeners[index]?.();
    },
    disconnect(code = 1006, index = 0) {
      closeListeners[index]?.(code);
    },
  };
}

describe("AI 抽屉会话", () => {
  test("模型服务未配置：隐藏 provider 细节、保留原请求并可从同一用户消息重试", async () => {
    let attempts = 0;
    const h = harness({
      startChat: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Missing OPENAI_API_KEY\n    at createOpenAIProvider"), {
            code: "ai-not-configured",
          });
        }
        return { runId: "run-retry", streamUrl: "/api/chat/stream?runId=run-retry", streamToken: "retry-token" };
      },
    });

    await h.session.sendMessage("总结当前债权", context());

    expect(h.session.snapshot()).toMatchObject({
      sending: false,
      sendError: "当前环境未配置 AI 服务",
      retryableMessageId: "id-1",
    });
    expect(h.session.snapshot().messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ["id-1", "user", "总结当前债权"],
    ]);

    await h.session.retryMessage("id-1");

    expect(attempts).toBe(2);
    expect(h.session.snapshot().messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(h.session.snapshot()).toMatchObject({
      sendError: null,
      retryableMessageId: null,
      activeRun: { runId: "run-retry" },
    });
  });

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

  test("stream 只有 ping 后超时：退出路由中状态并展示可理解错误", async () => {
    const h = harness();

    const sending = h.session.sendMessage("hi", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    h.emit({ kind: "ping", runId: "run-1" });
    expect(h.session.snapshot().sending).toBe(true);
    expect(h.session.snapshot().progressHint).toBe("路由中…");

    h.timeout();

    const state = h.session.snapshot();
    expect(state.sending).toBe(false);
    expect(state.progressHint).toBeNull();
    expect(state.activeRun).toBeNull();
    expect(state.sendError).toContain("超时");
    expect(state.retryableMessageId).toBe("id-1");
    expect(h.handles[0]?.closed).toBe(true);
  });

  test("stream 重连耗尽后中断：保留原消息、退出 loading 并提供网络错误重试", async () => {
    const h = harness();

    const sending = h.session.sendMessage("读取当前记录", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    h.disconnect();

    expect(h.session.snapshot()).toMatchObject({
      sending: false,
      activeRun: null,
      sendError: "AI 连接已中断，请检查网络后重试。",
      retryableMessageId: "id-1",
    });
    expect(h.session.snapshot().messages[0]).toMatchObject({ role: "user", content: "读取当前记录" });
  });

  test("未知 stream error：退出路由中状态并隐藏 provider 技术细节", async () => {
    const h = harness();

    const sending = h.session.sendMessage("hi", context());
    h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
    await sending;

    h.emit({ kind: "error", runId: "run-1", code: "chat-failed", message: "storage failed" });

    const state = h.session.snapshot();
    expect(state.sending).toBe(false);
    expect(state.progressHint).toBeNull();
    expect(state.activeRun).toBeNull();
    expect(state.sendError).toBe("AI 服务暂时不可用，请稍后重试。");
    expect(h.handles[0]?.closed).toBe(true);
  });

  test("stream error 按权限与校验类别显示可区分的中文提示", async () => {
    const cases = [
      ["chat-signin-failed", "PERMISSIONS denied for user:abc", "没有权限执行此操作，请联系工作区管理员。"],
      ["chat-resume-invalid", "ZodError: expected string", "请求内容未通过校验，请检查后重试。"],
    ] as const;

    for (const [code, rawMessage, expected] of cases) {
      const h = harness();
      const sending = h.session.sendMessage("执行任务", context());
      h.start.resolve({ runId: "run-1", streamUrl: "/api/chat/stream?runId=run-1", streamToken: "stream-token" });
      await sending;

      h.emit({ kind: "error", runId: "run-1", code, message: rawMessage });

      expect(h.session.snapshot().sendError).toBe(expected);
    }
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

    const resuming = h.session.resumeWrite("id-2", "write-confirmed");
    await Promise.resolve();

    expect(h.resumes).toEqual([{ runId: "run-1", decision: { kind: "write-confirmed" } }]);
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(false);
    expect(h.handles).toHaveLength(2);

    h.emit({ kind: "done", runId: "run-1", message: assistantMessage("已写入 1 个字段"), toolCalls: [] }, 1);
    await resuming;

    const done = h.session.snapshot();
    expect(done.pendingIntents[0]?.dismissed).toBe(true);
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

    await expect(h.session.resumeWrite("id-2", "write-rejected")).rejects.toThrow("AI 服务暂时不可用，请稍后重试。");

    const state = h.session.snapshot();
    expect(state.pendingIntents[0]?.dismissed).toBe(false);
    expect(state.sending).toBe(false);
    expect(state.progressHint).toBeNull();
  });

  test("resume stream 异步失败：同一确认卡保留，并以原 runId 再次提交同一决定", async () => {
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
        intent: { type: "row-patch-proposal", sheetId: "sheet:claims", recordId: "ent_claim:one", proposals: [] },
      },
    });

    const firstResume = h.session.resumeWrite("id-2", "write-confirmed");
    await Promise.resolve();
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(false);
    h.emit({ kind: "error", runId: "run-1", code: "chat-failed", message: "provider connection reset" }, 1);
    await expect(firstResume).rejects.toThrow("网络连接异常，请检查网络后重试。");

    const secondResume = h.session.resumeWrite("id-2", "write-confirmed");
    await Promise.resolve();
    h.emit({ kind: "done", runId: "run-1", message: assistantMessage("已继续执行"), toolCalls: [] }, 2);
    await secondResume;

    expect(h.resumes).toEqual([
      { runId: "run-1", decision: { kind: "write-confirmed" } },
      { runId: "run-1", decision: { kind: "write-confirmed" } },
    ]);
    expect(h.session.snapshot().pendingIntents[0]?.dismissed).toBe(true);
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

    await expect(h.session.finishResearch("id-2", ["resource_item:r1"])).rejects.toThrow("AI 服务暂时不可用，请稍后重试。");
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
