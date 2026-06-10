import type {
  AiChatMessage,
  AiContextSnapshot,
  AiProgressEvent,
  AiToolCallRecord,
  ChatStreamEvent,
  ResumeDecision,
} from "@surreal-ck/shared";

export type AiDrawerContextSnapshot = AiContextSnapshot & {
  workspaceSlug?: string;
};

export type ChatRunStart = {
  runId: string;
  streamUrl: string;
  streamToken: string;
};

export type AiDrawerChatClient = {
  startChat(input: { message: string; contextSnapshot?: AiDrawerContextSnapshot }): Promise<ChatRunStart>;
  resumeChat(runId: string, decision: ResumeDecision): Promise<ChatRunStart>;
};

export type AiDrawerStreamInput = {
  url: string;
  streamToken: string;
  onEvent: (event: ChatStreamEvent) => void;
  onClose?: (code: number) => void;
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
  kind: "ambiguous-candidates" | "resource-candidates" | "await-write-confirm";
  candidates?: Array<{
    id: string;
    label: string;
    summary?: string;
    score?: number;
    resourceType?: string;
    sourceUrl?: string;
  }>;
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
  sendMessage(message: string, contextSnapshot: AiDrawerContextSnapshot): Promise<void>;
  chooseCandidate(messageId: string, candidateId: string): Promise<void>;
  syncWorkspace(workspaceSlug: string | null | undefined): void;
  dispose(): void;
};

const ROUTING_HINT = "路由中…";

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
      } else if (event.payload.kind === "await-write-confirm") {
        state.pendingIntents = [
          ...state.pendingIntents,
          {
            messageId,
            runId: event.runId,
            kind: event.payload.kind,
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

  async function sendMessage(message: string, contextSnapshot: AiDrawerContextSnapshot): Promise<void> {
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
      const run = await options.chatClient.startChat({ message: content, contextSnapshot });
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
