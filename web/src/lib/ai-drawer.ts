import type {
  AiChatMessage,
  AiContextSnapshot,
  AiProgressEvent,
  AiToolCallRecord,
  ChatStreamEvent,
  DashboardDraftIntent,
  ResumeDecision,
  RowPatchProposal,
} from "@surreal-ck/shared";

export type AiDrawerContextSnapshot = AiContextSnapshot & {
  workspaceSlug?: string;
};

export type ChatRunStart = {
  runId: string;
  streamUrl: string;
  streamToken: string;
};

export type AiComposerMode = "chat" | "resource-search";

export type AiDrawerChatClient = {
  startChat(input: {
    message: string;
    contextSnapshot?: AiDrawerContextSnapshot;
    /** composer 显式提交模式；resource-search 确定性进入资源检索子 agent（RR-011/RR-014）。 */
    composerMode?: AiComposerMode;
  }): Promise<ChatRunStart>;
  resumeChat(runId: string, decision: ResumeDecision): Promise<ChatRunStart>;
};

export type AiDrawerStreamInput = {
  url: string;
  streamToken: string;
  onEvent: (event: ChatStreamEvent) => void;
  onClose?: (code: number) => void;
  onIdleTimeout?: () => void;
};

export type AiDrawerStreamHandle = {
  close(): void;
  closed?: boolean;
};

export type ActiveAiRun = {
  runId: string;
  messageId: string;
};

export type PendingAiIntent = {
  messageId: string;
  runId: string;
  kind: "ambiguous-candidates" | "resource-candidates" | "await-write-confirm" | "manual-research";
  candidates?: Array<{
    id: string;
    label: string;
    summary?: string;
    score?: number;
    resourceType?: string;
    sourceUrl?: string;
  }>;
  /** 仅 kind === "await-write-confirm" 且 intent 是行分析提案时携带，驱动提案卡渲染。 */
  proposal?: RowPatchProposal;
  /** 仅 kind === "await-write-confirm" 且 intent 是仪表盘草稿时携带，驱动草稿卡渲染（D3-05）。 */
  dashboardDraft?: DashboardDraftIntent;
  /** 仅 kind === "manual-research" 携带：人工检索 panel 的会话上下文（RR-012）。 */
  research?: {
    sessionId: string;
    query: string;
    resourceType: string;
  };
  dismissed: boolean;
};

export type AiDrawerState = {
  messages: AiChatMessage[];
  pendingIntents: PendingAiIntent[];
  toolCallsByMessageId: Record<string, AiToolCallRecord[]>;
  sending: boolean;
  sendError: string | null;
  progressHint: string | null;
  activeRun: ActiveAiRun | null;
  workspaceSlug: string | null;
};

export type AiDrawerSessionOptions = {
  chatClient: AiDrawerChatClient;
  connectStream: (input: AiDrawerStreamInput) => AiDrawerStreamHandle;
  createId?: () => string;
  now?: () => string;
  onChange?: (state: AiDrawerState) => void;
};

export type AiDrawerSession = {
  snapshot(): AiDrawerState;
  sendMessage(
    message: string,
    contextSnapshot: AiDrawerContextSnapshot,
    options?: { composerMode?: AiComposerMode },
  ): Promise<void>;
  chooseCandidate(messageId: string, candidateId: string): Promise<void>;
  resumeWrite(messageId: string, decision: "write-confirmed" | "write-rejected"): Promise<void>;
  /** 人工检索完成：用已保存的资源 id resume workflow。成功才 dismiss 检索卡，失败上抛可重试。 */
  finishResearch(messageId: string, resourceIds: string[]): Promise<void>;
  syncWorkspace(workspaceSlug: string | null | undefined): void;
  dispose(): void;
};

const ROUTING_HINT = "路由中…";
const STREAM_TIMEOUT_MESSAGE = "AI 响应超时，请重试。";

export function progressEventToHint(event: AiProgressEvent): string {
  switch (event.kind) {
    case "routing":
      return ROUTING_HINT;
    case "agent-step":
      return `${event.agentName}：${event.taskText}`;
    case "tool-call":
      return `正在调用 ${event.toolId}…`;
  }
}

export function createAiDrawerSession(options: AiDrawerSessionOptions): AiDrawerSession {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  let activeStream: AiDrawerStreamHandle | null = null;

  const state: AiDrawerState = {
    messages: [],
    pendingIntents: [],
    toolCallsByMessageId: {},
    sending: false,
    sendError: null,
    progressHint: null,
    activeRun: null,
    workspaceSlug: null,
  };

  function cloneState(): AiDrawerState {
    return {
      ...state,
      messages: state.messages.map((message) => ({ ...message })),
      pendingIntents: state.pendingIntents.map((intent) => ({ ...intent })),
      toolCallsByMessageId: Object.fromEntries(
        Object.entries(state.toolCallsByMessageId).map(([key, value]) => [key, value.map((toolCall) => ({ ...toolCall }))]),
      ),
      activeRun: state.activeRun ? { ...state.activeRun } : null,
    };
  }

  function emitChange(): void {
    options.onChange?.(cloneState());
  }

  function replaceMessage(id: string, next: AiChatMessage): void {
    state.messages = state.messages.map((message) => (message.id === id ? next : message));
  }

  function patchMessage(id: string, patch: Partial<AiChatMessage>): void {
    state.messages = state.messages.map((message) => (message.id === id ? { ...message, ...patch } : message));
  }

  function clearRun(runId: string): void {
    if (state.activeRun?.runId === runId) {
      state.activeRun = null;
    }
  }

  function markPendingDismissed(messageId: string): void {
    state.pendingIntents = state.pendingIntents.map((intent) =>
      intent.messageId === messageId ? { ...intent, dismissed: true } : intent,
    );
  }

  function closeActiveStream(): void {
    activeStream?.close();
    activeStream = null;
  }

  function connectRun(run: ChatRunStart, messageId: string): void {
    closeActiveStream();
    state.activeRun = { runId: run.runId, messageId };
    activeStream = options.connectStream({
      url: run.streamUrl,
      streamToken: run.streamToken,
      onEvent: (event) => handleStreamEvent(event, messageId),
      onClose: () => {
        if (state.activeRun?.runId === run.runId) {
          state.sending = false;
          state.progressHint = null;
          clearRun(run.runId);
          emitChange();
        }
      },
      onIdleTimeout: () => {
        handleStreamEvent({
          kind: "error",
          runId: run.runId,
          code: "stream-timeout",
          message: STREAM_TIMEOUT_MESSAGE,
        }, messageId);
      },
    });
    emitChange();
  }

  function handleStreamEvent(event: ChatStreamEvent, messageId: string): void {
    if (event.kind === "ping") return;
    if (!state.activeRun || event.runId !== state.activeRun.runId) return;

    if (event.kind === "progress") {
      state.progressHint = progressEventToHint(event.progress);
      emitChange();
      return;
    }

    if (event.kind === "chunk") {
      const message = state.messages.find((item) => item.id === messageId);
      patchMessage(messageId, { content: `${message?.content ?? ""}${event.text}` });
      emitChange();
      return;
    }

    if (event.kind === "done") {
      replaceMessage(messageId, event.message);
      if (event.toolCalls.length > 0) {
        state.toolCallsByMessageId = { ...state.toolCallsByMessageId, [event.message.id]: event.toolCalls };
      }
      state.sending = false;
      state.progressHint = null;
      clearRun(event.runId);
      closeActiveStream();
      emitChange();
      return;
    }

    if (event.kind === "suspend") {
      if (event.payload.kind === "ambiguous-candidates" || event.payload.kind === "resource-candidates") {
        state.pendingIntents = [
          ...state.pendingIntents,
          {
            messageId,
            runId: event.runId,
            kind: event.payload.kind,
            candidates: event.payload.candidates,
            dismissed: false,
          },
        ];
        const message = state.messages.find((item) => item.id === messageId);
        if (message && !message.content.trim()) {
          patchMessage(messageId, {
            content: event.payload.kind === "resource-candidates"
              ? "找到可能相关的资源，请选择要用于回答的资料。"
              : "找到多个候选，请先选择一个结果。",
          });
        }
      } else if (event.payload.kind === "manual-research") {
        state.pendingIntents = [
          ...state.pendingIntents,
          {
            messageId,
            runId: event.runId,
            kind: "manual-research",
            research: {
              sessionId: event.payload.sessionId,
              query: event.payload.query,
              resourceType: event.payload.resourceType,
            },
            dismissed: false,
          },
        ];
        const message = state.messages.find((item) => item.id === messageId);
        if (message && !message.content.trim()) {
          patchMessage(messageId, {
            content: "资源库没有找到足够相关的资料，已开启人工检索；保存资源并完成检索后我会继续回答。",
          });
        }
      } else if (event.payload.kind === "await-write-confirm") {
        const intent = event.payload.intent;
        state.pendingIntents = [
          ...state.pendingIntents,
          {
            messageId,
            runId: event.runId,
            kind: event.payload.kind,
            ...(intent.type === "row-patch-proposal" ? { proposal: intent } : {}),
            ...(intent.type === "dashboard-draft" ? { dashboardDraft: intent } : {}),
            dismissed: false,
          },
        ];
      }
      state.sending = false;
      state.progressHint = null;
      closeActiveStream();
      emitChange();
      return;
    }

    if (event.kind === "error") {
      state.sending = false;
      state.progressHint = null;
      state.sendError = event.message;
      clearRun(event.runId);
      closeActiveStream();
      emitChange();
    }
  }

  async function chooseCandidate(messageId: string, candidateId: string): Promise<void> {
    const pending = state.pendingIntents.find((intent) =>
      intent.messageId === messageId
      && !intent.dismissed
      && (intent.kind === "ambiguous-candidates" || intent.kind === "resource-candidates"),
    );
    if (!pending) return;

    const decision: ResumeDecision = pending.kind === "resource-candidates"
      ? { kind: "resource-candidates-chosen", resourceIds: [candidateId] }
      : { kind: "candidate-chosen", candidateId };

    markPendingDismissed(messageId);
    state.sending = true;
    state.sendError = null;
    state.progressHint = ROUTING_HINT;
    emitChange();

    try {
      const run = await options.chatClient.resumeChat(pending.runId, decision);
      connectRun(run, messageId);
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      state.sendError = error instanceof Error ? error.message : String(error);
      emitChange();
    }
  }

  /**
   * 提案卡确认/忽略后的 resume：成功才 dismiss 卡片并重连 stream；
   * 失败把错误上抛给卡片状态机展示（卡片保留可重试），不污染 sendError。
   */
  async function resumeWrite(messageId: string, decision: "write-confirmed" | "write-rejected"): Promise<void> {
    const pending = state.pendingIntents.find((intent) =>
      intent.messageId === messageId && !intent.dismissed && intent.kind === "await-write-confirm",
    );
    if (!pending) return;

    state.sending = true;
    state.sendError = null;
    state.progressHint = ROUTING_HINT;
    emitChange();

    try {
      const run = await options.chatClient.resumeChat(pending.runId, { kind: decision });
      markPendingDismissed(messageId);
      connectRun(run, messageId);
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      emitChange();
      throw error;
    }
  }

  /** 与 resumeWrite 同语义：成功才 dismiss 检索卡并重连 stream；失败上抛，检索卡保留可重试。 */
  async function finishResearch(messageId: string, resourceIds: string[]): Promise<void> {
    const pending = state.pendingIntents.find((intent) =>
      intent.messageId === messageId && !intent.dismissed && intent.kind === "manual-research",
    );
    if (!pending || resourceIds.length === 0) return;

    state.sending = true;
    state.sendError = null;
    state.progressHint = ROUTING_HINT;
    emitChange();

    try {
      const run = await options.chatClient.resumeChat(pending.runId, {
        kind: "manual-research-completed",
        resourceIds,
      });
      markPendingDismissed(messageId);
      connectRun(run, messageId);
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      emitChange();
      throw error;
    }
  }

  async function sendMessage(
    message: string,
    contextSnapshot: AiDrawerContextSnapshot,
    sendOptions?: { composerMode?: AiComposerMode },
  ): Promise<void> {
    const content = message.trim();
    if (!content || state.activeRun) return;

    state.workspaceSlug = contextSnapshot.workspaceSlug ?? state.workspaceSlug;
    const userMessage: AiChatMessage = {
      id: createId(),
      role: "user",
      content,
      createdAt: now(),
      context: contextSnapshot,
    };
    const assistantMessage: AiChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      createdAt: now(),
      context: contextSnapshot,
    };

    state.messages = [...state.messages, userMessage, assistantMessage];
    state.sending = true;
    state.sendError = null;
    state.progressHint = ROUTING_HINT;
    emitChange();

    try {
      const run = await options.chatClient.startChat({
        message: content,
        contextSnapshot,
        ...(sendOptions?.composerMode ? { composerMode: sendOptions.composerMode } : {}),
      });
      connectRun(run, assistantMessage.id);
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      state.sendError = error instanceof Error ? error.message : String(error);
      state.messages = state.messages.filter((item) => item.id !== assistantMessage.id);
      emitChange();
    }
  }

  function syncWorkspace(workspaceSlug: string | null | undefined): void {
    const nextSlug = workspaceSlug ?? null;
    if (state.workspaceSlug === nextSlug) return;
    const hadWorkspace = state.workspaceSlug !== null;
    state.workspaceSlug = nextSlug;
    if (!hadWorkspace) return;

    closeActiveStream();
    state.activeRun = null;
    state.sending = false;
    state.progressHint = null;
    state.pendingIntents = state.pendingIntents.map((intent) => ({ ...intent, dismissed: true }));
    emitChange();
  }

  return {
    snapshot: cloneState,
    sendMessage,
    chooseCandidate,
    resumeWrite,
    finishResearch,
    syncWorkspace,
    dispose() {
      closeActiveStream();
      state.sending = false;
      state.progressHint = null;
      state.activeRun = null;
      emitChange();
    },
  };
}

export function toolCallTraceLabel(toolCall: AiToolCallRecord): string {
  return toolCall.toolName;
}
