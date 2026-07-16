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
  /** 最近一次可安全重发的读取请求所对应的用户消息。 */
  retryableMessageId: string | null;
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
  /** 在原用户消息下重发同一读取请求，不复制用户消息。 */
  retryMessage(messageId: string): Promise<void>;
  syncWorkspace(workspaceSlug: string | null | undefined): void;
  dispose(): void;
};

const ROUTING_HINT = "路由中…";
const STREAM_TIMEOUT_MESSAGE = "AI 响应超时，请重试。";
const AI_USER_MESSAGES = new Set([
  "当前环境未配置 AI 服务",
  STREAM_TIMEOUT_MESSAGE,
  "AI 连接已中断，请检查网络后重试。",
  "没有权限执行此操作，请联系工作区管理员。",
  "请求内容未通过校验，请检查后重试。",
  "网络连接异常，请检查网络后重试。",
  "AI 服务暂时不可用，请稍后重试。",
]);

type RetryableRequest = {
  message: string;
  contextSnapshot: AiDrawerContextSnapshot;
  composerMode?: AiComposerMode;
  assistantMessageId: string;
};

type PendingRunCompletion = {
  runId: string;
  pendingIntent: PendingAiIntent;
  resolve: () => void;
  reject: (error: Error) => void;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function aiErrorMessage(error: unknown): string {
  const code = errorCode(error)?.toLowerCase() ?? "";
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  const searchable = `${code} ${rawMessage}`.toLowerCase();

  if (AI_USER_MESSAGES.has(rawMessage)) return rawMessage;
  if (
    code === "ai-not-configured"
    || /missing[\s_-]*(?:ai[\s_-]*settings|[a-z_]*api[\s_-]*key)|ai service[^\n]*not configured|resumer not configured/u.test(searchable)
  ) {
    return "当前环境未配置 AI 服务";
  }
  if (code === "stream-timeout") return STREAM_TIMEOUT_MESSAGE;
  if (/forbidden|unauthori[sz]ed|permission|signin-failed|access denied/u.test(searchable)) {
    return "没有权限执行此操作，请联系工作区管理员。";
  }
  if (/validation|invalid|bad-request|zoderror|unprocessable/u.test(searchable)) {
    return "请求内容未通过校验，请检查后重试。";
  }
  if (/network|fetch failed|connection|stream-interrupted/u.test(searchable)) {
    return "网络连接异常，请检查网络后重试。";
  }
  return "AI 服务暂时不可用，请稍后重试。";
}

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
  let pendingRunCompletion: PendingRunCompletion | null = null;
  const retryableRequests = new Map<string, RetryableRequest>();

  const state: AiDrawerState = {
    messages: [],
    pendingIntents: [],
    toolCallsByMessageId: {},
    sending: false,
    sendError: null,
    progressHint: null,
    activeRun: null,
    workspaceSlug: null,
    retryableMessageId: null,
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

  function userMessageIdForAssistant(assistantMessageId: string): string | null {
    for (const [userMessageId, request] of retryableRequests) {
      if (request.assistantMessageId === assistantMessageId) return userMessageId;
    }
    return null;
  }

  function markPendingDismissed(messageId: string): void {
    state.pendingIntents = state.pendingIntents.map((intent) =>
      intent.messageId === messageId ? { ...intent, dismissed: true } : intent,
    );
  }

  function markIntentDismissed(target: PendingAiIntent): void {
    state.pendingIntents = state.pendingIntents.map((intent) =>
      intent === target ? { ...intent, dismissed: true } : intent,
    );
  }

  function settleRunCompletion(runId: string, error?: Error): void {
    if (pendingRunCompletion?.runId !== runId) return;
    const completion = pendingRunCompletion;
    pendingRunCompletion = null;
    if (error) {
      completion.reject(error);
      return;
    }
    markIntentDismissed(completion.pendingIntent);
    completion.resolve();
  }

  function closeActiveStream(): void {
    activeStream?.close();
    activeStream = null;
  }

  function connectRun(run: ChatRunStart, messageId: string, allowRequestRetry = false): void {
    closeActiveStream();
    state.activeRun = { runId: run.runId, messageId };
    activeStream = options.connectStream({
      url: run.streamUrl,
      streamToken: run.streamToken,
      onEvent: (event) => handleStreamEvent(event, messageId, allowRequestRetry),
      onClose: () => {
        if (state.activeRun?.runId === run.runId) {
          state.sending = false;
          state.progressHint = null;
          state.sendError = "AI 连接已中断，请检查网络后重试。";
          state.retryableMessageId = allowRequestRetry ? userMessageIdForAssistant(messageId) : null;
          settleRunCompletion(run.runId, new Error(state.sendError));
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
        }, messageId, allowRequestRetry);
      },
    });
    emitChange();
  }

  function handleStreamEvent(event: ChatStreamEvent, messageId: string, allowRequestRetry = false): void {
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
      settleRunCompletion(event.runId);
      emitChange();
      return;
    }

    if (event.kind === "suspend") {
      settleRunCompletion(event.runId);
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
      state.sendError = aiErrorMessage(event);
      state.retryableMessageId = allowRequestRetry ? userMessageIdForAssistant(messageId) : null;
      settleRunCompletion(event.runId, new Error(state.sendError));
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
      state.sendError = aiErrorMessage(error);
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
      const completion = new Promise<void>((resolve, reject) => {
        pendingRunCompletion = { runId: run.runId, pendingIntent: pending, resolve, reject };
      });
      connectRun(run, messageId);
      await completion;
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      emitChange();
      throw new Error(aiErrorMessage(error));
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
      throw new Error(aiErrorMessage(error));
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

    retryableRequests.set(userMessage.id, {
      message: content,
      contextSnapshot,
      ...(sendOptions?.composerMode ? { composerMode: sendOptions.composerMode } : {}),
      assistantMessageId: assistantMessage.id,
    });

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
      connectRun(run, assistantMessage.id, true);
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      state.sendError = aiErrorMessage(error);
      state.retryableMessageId = userMessage.id;
      state.messages = state.messages.filter((item) => item.id !== assistantMessage.id);
      emitChange();
    }
  }

  async function retryMessage(messageId: string): Promise<void> {
    const request = retryableRequests.get(messageId);
    if (!request || state.activeRun || state.sending) return;

    const assistantMessage: AiChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      createdAt: now(),
      context: request.contextSnapshot,
    };
    const previousAssistantMessageId = request.assistantMessageId;
    request.assistantMessageId = assistantMessage.id;
    state.messages = [...state.messages.filter((item) => item.id !== previousAssistantMessageId), assistantMessage];
    state.sending = true;
    state.sendError = null;
    state.retryableMessageId = null;
    state.progressHint = ROUTING_HINT;
    emitChange();

    try {
      const run = await options.chatClient.startChat({
        message: request.message,
        contextSnapshot: request.contextSnapshot,
        ...(request.composerMode ? { composerMode: request.composerMode } : {}),
      });
      connectRun(run, assistantMessage.id, true);
    } catch (error) {
      state.sending = false;
      state.progressHint = null;
      state.sendError = aiErrorMessage(error);
      state.retryableMessageId = messageId;
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
    retryMessage,
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
