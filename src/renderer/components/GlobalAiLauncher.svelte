<script lang="ts">
  import { marked } from "marked";
  import { buildAiContextSnapshot, createAiUserMessage } from "../../shared/ai-context";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { appApi } from "../lib/app-api";
  import { appState } from "../lib/app-state.svelte";
  import { editorStore } from "../lib/editor.svelte";
  import { subscribeAiChunks, subscribeAiProgress, subscribeAiRunCancelled, subscribeAiSuspended } from "../lib/rpc";
  import {
    applyAiChunkToMessages,
    applyAiRunCancelledToMessages,
    applyAiSuspendedToMessages,
    buildRowPatchIntentFromProposal,
    researchWindowRequestFromSuspendedEvent,
    type ActiveAiRun,
    type PendingIntent,
  } from "./global-ai-stream";
  import {
    buildComposerSendOptions,
    composerModeView,
    selectComposerMode,
    type AiComposerMode,
  } from "./global-ai-composer";
  import { progressEventToHint } from "./ai-progress-label";
  import { getDashboardWidget } from "../features/dashboard/registries/widgets";
  import Icon from "./Icon.svelte";

  marked.setOptions({ breaks: true });

  function renderMarkdown(text: string): string {
    return marked.parse(text) as string;
  }
  import type { AiChatMessage } from "../../shared/ai-context";
  import type {
    AppNavigationIntent,
    DashboardCacheDTO,
    DashboardDraftIntent,
    DashboardViewDTO,
    ResumeDecision,
    RowPatchProposal,
    ToolNavigationIntent,
    AiMessageChunkEvent,
    AiRunCancelledEvent,
    WorkflowSuspendedEvent,
  } from "../../shared/rpc.types";
  import type { Navigate, RouteState, ScreenId } from "../lib/types";

  let {
    route,
    navigate,
  }: {
    route: RouteState;
    navigate: Navigate;
  } = $props();

  let prompt = $state("");
  let messages = $state<AiChatMessage[]>([]);
  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let pendingIntents = $state<PendingIntent[]>([]);
  let progressHint = $state<string | null>(null);
  let savingIntentId = $state<string | null>(null);
  let acceptedRowPatchFields = $state<Record<string, string[]>>({});
  let selectedResourceCandidateIds = $state<Record<string, string[]>>({});
  let composerMode = $state<AiComposerMode>("chat");
  let composerMenuOpen = $state(false);
  let activeRun = $state<ActiveAiRun | null>(null);
  let cancellingRun = $state(false);
  let cleanupActiveStream: (() => void) | null = null;
  let unsubscribeActiveRunCancelled: (() => void) | null = null;
  const activeComposerMode = $derived(composerModeView(composerMode));

  function navigateFromAiAction(action: AppNavigationIntent) {
    navigate(action.screen as ScreenId, {
      workbookId: action.workbookId,
      sheetId: action.sheetId,
      dashboardPageId: action.dashboardPageId,
    });
  }

  function applyChunkEvent(placeholderId: string, event: AiMessageChunkEvent, streamedText: string): string {
    const next = applyAiChunkToMessages(
      { messages, pendingIntents, sending, sendError, streamedText },
      placeholderId,
      event,
    );
    messages = next.messages;
    pendingIntents = next.pendingIntents;
    sending = next.sending;
    sendError = next.sendError;
    return next.streamedText;
  }

  function applySuspendedEvent(placeholderId: string, event: WorkflowSuspendedEvent, streamedText: string): string {
    const next = applyAiSuspendedToMessages(
      { messages, pendingIntents, sending, sendError, streamedText },
      placeholderId,
      event,
    );
    messages = next.messages;
    pendingIntents = next.pendingIntents;
    sending = next.sending;
    sendError = next.sendError;
    return next.streamedText;
  }

  function handleRunCancelled(event: AiRunCancelledEvent) {
    cleanupActiveStream?.();
    cleanupActiveStream = null;
    const next = applyAiRunCancelledToMessages(
      { messages, pendingIntents, sending, sendError, streamedText: "" },
      activeRun,
      event,
    );
    messages = next.messages;
    pendingIntents = next.pendingIntents;
    sending = next.sending;
    sendError = next.sendError;
    progressHint = null;
    clearActiveRun();
  }

  function registerActiveRun(run: ActiveAiRun) {
    unsubscribeActiveRunCancelled?.();
    activeRun = run;
    cancellingRun = false;
    unsubscribeActiveRunCancelled = subscribeAiRunCancelled(run.runId, handleRunCancelled);
  }

  function updateActiveResearchSession(event: WorkflowSuspendedEvent) {
    if (event.kind !== "manual-research" || !activeRun || activeRun.runId !== event.runId) return;
    activeRun = { ...activeRun, sessionId: event.sessionId };
  }

  function clearActiveRun(runId?: string) {
    if (runId && activeRun?.runId !== runId) return;
    activeRun = null;
    cancellingRun = false;
    unsubscribeActiveRunCancelled?.();
    unsubscribeActiveRunCancelled = null;
  }

  async function terminateActiveRun() {
    if (!activeRun || cancellingRun) return;
    const run = activeRun;
    cancellingRun = true;
    composerMenuOpen = false;
    const res = await appApi.cancelAiWorkflow({
      runId: run.runId,
      sessionId: run.sessionId,
      reason: "user-cancelled",
    });
    if (!res.ok) {
      sendError = res.message;
      cancellingRun = false;
      return;
    }
    handleRunCancelled(res.data.event);
  }

  async function openResearchWindowForSuspendedEvent(event: WorkflowSuspendedEvent) {
    const req = researchWindowRequestFromSuspendedEvent(event);
    if (!req) return;
    const res = await appApi.openResearchWindow(req);
    if (!res.ok) sendError = res.message;
  }

  async function executeNavigationIntent(intent: ToolNavigationIntent, runId?: string) {
    const res = await appApi.executeAiAction(intent, runId ? { runId } : undefined);
    if (!res.ok) {
      sendError = res.message;
      return false;
    }
    if (res.data.navigation) navigateFromAiAction(res.data.navigation);
    return true;
  }

  async function confirmNavigationIntent(intent: ToolNavigationIntent, messageId: string, runId?: string) {
    const executed = await executeNavigationIntent(intent, runId);
    if (executed) {
      dismissIntent(messageId, { skipResume: true });
      if (runId) clearActiveRun(runId);
    }
  }

  async function confirmDashboardDraftIntent(intent: DashboardDraftIntent, messageId: string, runId?: string) {
    savingIntentId = messageId;
    sendError = null;
    try {
      const res = await appApi.executeAiAction(intent, runId ? { runId } : undefined);
      if (!res.ok) {
        sendError = res.message;
        return;
      }
      if (res.data.navigation) navigateFromAiAction(res.data.navigation);
      dismissIntent(messageId, { skipResume: true });
      if (runId) clearActiveRun(runId);
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    } finally {
      savingIntentId = null;
    }
  }

  async function confirmRowPatchProposalIntent(intent: RowPatchProposal, messageId: string, runId?: string) {
    const accepted = acceptedFieldsForRowPatch(messageId, intent);
    if (!accepted.size) {
      dismissIntent(messageId);
      return;
    }

    savingIntentId = messageId;
    sendError = null;
    try {
      const res = await appApi.executeAiAction(
        buildRowPatchIntentFromProposal(intent, accepted),
        runId ? { runId } : undefined,
      );
      if (!res.ok) {
        sendError = res.message;
        return;
      }
      dismissIntent(messageId, { skipResume: true });
      if (runId) clearActiveRun(runId);
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    } finally {
      savingIntentId = null;
    }
  }

  function dismissIntent(messageId: string, options: { skipResume?: boolean } = {}) {
    const pending = pendingIntents.find((p) => p.messageId === messageId && !p.dismissed);
    if (!options.skipResume && pending?.runId && pending.suspendKind) {
      const decision: ResumeDecision = pending.suspendKind === "await-write-confirm"
        ? { kind: "write-rejected" }
        : { kind: "candidate-cancelled" };
      void appApi.resumeAiWorkflow(pending.runId, decision).finally(() => clearActiveRun(pending.runId));
    }
    pendingIntents = pendingIntents.map((p) =>
      p.messageId === messageId ? { ...p, dismissed: true } : p,
    );
  }

  async function chooseAmbiguousCandidate(pending: PendingIntent, candidateId: string) {
    if (!pending.runId || pending.suspendKind !== "ambiguous-candidates") {
      const candidate = pending.intent.type === "ambiguous"
        ? pending.intent.candidates.find((item) => item.id === candidateId)
        : null;
      if (candidate) {
        await confirmNavigationIntent({ type: "open-workbook", workbookId: candidate.id, label: candidate.label }, pending.messageId);
      }
      return;
    }

    dismissIntent(pending.messageId, { skipResume: true });
    await resumeSuspendedIntent(pending.messageId, pending.runId, {
      kind: "candidate-chosen",
      candidateId,
    });
  }

  function resourceSelectionFor(messageId: string): Set<string> {
    return new Set(selectedResourceCandidateIds[messageId] ?? []);
  }

  function isResourceCandidateSelected(messageId: string, candidateId: string): boolean {
    return resourceSelectionFor(messageId).has(candidateId);
  }

  function toggleResourceCandidate(messageId: string, candidateId: string) {
    const next = resourceSelectionFor(messageId);
    if (next.has(candidateId)) next.delete(candidateId);
    else next.add(candidateId);
    selectedResourceCandidateIds = { ...selectedResourceCandidateIds, [messageId]: Array.from(next) };
  }

  async function answerWithSelectedResources(pending: PendingIntent) {
    if (!pending.runId || pending.suspendKind !== "resource-candidates") return;
    const resourceIds = Array.from(resourceSelectionFor(pending.messageId));
    if (!resourceIds.length) return;
    dismissIntent(pending.messageId, { skipResume: true });
    await resumeSuspendedIntent(pending.messageId, pending.runId, {
      kind: "resource-candidates-chosen",
      resourceIds,
    });
  }

  async function continueResourceResearch(pending: PendingIntent) {
    if (!pending.runId || pending.suspendKind !== "resource-candidates") return;
    dismissIntent(pending.messageId, { skipResume: true });
    await resumeSuspendedIntent(pending.messageId, pending.runId, {
      kind: "resource-candidates-manual-research",
    });
  }

  function setComposerMode(mode: AiComposerMode) {
    const next = selectComposerMode({ prompt, mode: composerMode }, mode);
    prompt = next.prompt;
    composerMode = next.mode;
    composerMenuOpen = false;
  }

  async function resumeSuspendedIntent(messageId: string, runId: string, decision: ResumeDecision) {
    const streamId = `resume-${runId}`;
    let streamedText = "";
    sending = true;
    sendError = null;
    progressHint = null;

    let unsubscribeChunk: (() => void) | null = null;
    let unsubscribeProgress: (() => void) | null = null;
    let unsubscribeSuspended: (() => void) | null = null;
    const cleanup = () => {
      unsubscribeChunk?.();
      unsubscribeProgress?.();
      unsubscribeSuspended?.();
    };

    unsubscribeChunk = subscribeAiChunks(streamId, (event) => {
      streamedText = applyChunkEvent(messageId, event, streamedText);
      if (event.type === "error" || event.type === "done") {
        progressHint = null;
        cleanup();
        clearActiveRun(runId);
      }
    });
    unsubscribeProgress = subscribeAiProgress(runId, (event) => {
      progressHint = progressEventToHint(event);
    });
    unsubscribeSuspended = subscribeAiSuspended(runId, (event) => {
      streamedText = applySuspendedEvent(messageId, event, streamedText);
      updateActiveResearchSession(event);
      void openResearchWindowForSuspendedEvent(event);
      progressHint = null;
      cleanup();
    });

    try {
      const res = await appApi.resumeAiWorkflow(runId, decision);
      if (!res.ok) {
        sendError = res.message;
        sending = false;
        cleanup();
        return;
      }
      if (res.data.status === "cancelled") {
        sending = false;
        progressHint = null;
        cleanup();
        clearActiveRun(runId);
        return;
      }
      if (res.data.status === "success" && res.data.finalText && !streamedText) {
        streamedText = applyChunkEvent(messageId, {
          streamId,
          type: "done",
          toolCalls: [],
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            content: res.data.finalText,
            createdAt: new Date().toISOString(),
            context: contextSnapshot,
          },
        }, streamedText);
        cleanup();
        clearActiveRun(runId);
      }
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      sending = false;
      progressHint = null;
      cleanup();
      clearActiveRun(runId);
    }
  }

  function acceptedFieldsForRowPatch(messageId: string, intent: RowPatchProposal): Set<string> {
    return new Set(acceptedRowPatchFields[messageId] ?? intent.proposals.map((item) => item.field));
  }

  function isRowPatchFieldAccepted(messageId: string, intent: RowPatchProposal, field: string): boolean {
    return acceptedFieldsForRowPatch(messageId, intent).has(field);
  }

  function setRowPatchFieldAccepted(messageId: string, intent: RowPatchProposal, field: string, accepted: boolean) {
    const next = acceptedFieldsForRowPatch(messageId, intent);
    if (accepted) next.add(field);
    else next.delete(field);
    acceptedRowPatchFields = { ...acceptedRowPatchFields, [messageId]: Array.from(next) };
  }

  function formatPatchValue(value: unknown): string {
    if (value === null || value === undefined || value === "") return "空";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function confidenceLabel(confidence: RowPatchProposal["proposals"][number]["confidence"]): string {
    if (confidence === "high") return "高";
    if (confidence === "medium") return "中";
    return "低";
  }

  const currentSheet = $derived(editorStore.sheets.find((sheet) => sheet.id === editorStore.activeSheetId) ?? null);
  const contextSnapshot = $derived(buildAiContextSnapshot({
    route,
    workbook: editorStore.data ? { id: editorStore.data.workbook.id, name: editorStore.data.workbook.name } : null,
    sheet: currentSheet ? { id: currentSheet.id, label: currentSheet.label, tableName: currentSheet.tableName } : null,
    selectedRowId: editorUi.selectedRowId,
    rows: editorStore.rows,
    visibleColumns: editorStore.visibleColumns,
  }));

  function useExample(next: string) {
    prompt = next;
  }

  function contextTags(context = contextSnapshot): string[] {
    const tags: string[] = [];
    const { route, workbook, sheet, selectedRow } = context;
    tags.push(labelForScreen(route.screen));
    if (workbook?.name) tags.push(workbook.name);
    if (sheet?.label) tags.push(sheet.label);
    if (selectedRow?.label) tags.push(selectedRow.label);
    return tags;
  }

  function labelForScreen(screen: string): string {
    const labels: Record<string, string> = {
      home: "首页",
      dashboard: "仪表盘",
      editor: "表格",
      mydocs: "我的文档",
      settings: "设置",
      templates: "模板",
      admin: "管理",
      "admin-console": "控制台",
      form: "表单",
      "form-success": "表单",
    };
    return labels[screen] ?? "应用";
  }

  async function sendPrompt() {
    if (activeRun) return;
    const message = createAiUserMessage({ prompt, context: contextSnapshot });
    if (!message) return;

    const streamId = crypto.randomUUID();
    const placeholderId = crypto.randomUUID();
    const placeholder: AiChatMessage = {
      id: placeholderId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      context: message.context,
    };

    const history = messages.filter((m) => m.role === "user" || m.role === "assistant").slice();
    const sendOptions = buildComposerSendOptions(composerMode);
    messages = [...messages, message, placeholder];
    prompt = "";
    composerMenuOpen = false;
    sending = true;
    sendError = null;
    progressHint = null;
    let streamedText = "";
    let unsubscribeProgress: (() => void) | null = null;
    let unsubscribeSuspended: (() => void) | null = null;
    let responseRunId: string | null = null;

    const unsubscribe = subscribeAiChunks(streamId, (event) => {
      streamedText = applyChunkEvent(placeholderId, event, streamedText);
      if (event.type === "error" || event.type === "done") {
        progressHint = null;
        cleanupActiveStream?.();
        cleanupActiveStream = null;
        if (responseRunId) clearActiveRun(responseRunId);
      }
    });
    cleanupActiveStream = () => {
      unsubscribe();
      unsubscribeProgress?.();
      unsubscribeSuspended?.();
    };

    try {
      const res = await appApi.sendAiMessage(message, streamId, history, sendOptions);
      if (res.ok) {
        responseRunId = res.data.runId;
        if (!res.data.message.content && sending) {
          registerActiveRun({ runId: res.data.runId, messageId: placeholderId });
        }
        unsubscribeProgress = subscribeAiProgress(res.data.runId, (event) => {
          progressHint = progressEventToHint(event);
        });
        unsubscribeSuspended = subscribeAiSuspended(res.data.runId, (event) => {
          streamedText = applySuspendedEvent(placeholderId, event, streamedText);
          updateActiveResearchSession(event);
          void openResearchWindowForSuspendedEvent(event);
          progressHint = null;
          cleanupActiveStream?.();
          cleanupActiveStream = null;
        });
      }
      if (res.ok && res.data.message.content) {
        streamedText = applyChunkEvent(placeholderId, {
          streamId,
          type: "done",
          toolCalls: res.data.toolCalls,
          message: {
            id: res.data.message.id,
            content: res.data.message.content,
            role: res.data.message.role,
            createdAt: res.data.message.createdAt,
            context: res.data.message.context,
          },
        }, streamedText);
        if (responseRunId) clearActiveRun(responseRunId);
      } else if (!res.ok && streamedText) {
        messages = messages.map((m) =>
          m.id === placeholderId ? { ...m, content: streamedText } : m,
        );
        sendError = res.message;
        sending = false;
        progressHint = null;
        cleanupActiveStream?.();
        cleanupActiveStream = null;
        if (responseRunId) clearActiveRun(responseRunId);
      } else if (!res.ok) {
        sendError = res.message;
        messages = messages.filter((m) => m.id !== placeholderId);
        sending = false;
        progressHint = null;
        cleanupActiveStream?.();
        cleanupActiveStream = null;
        if (responseRunId) clearActiveRun(responseRunId);
      } else if (!streamedText && !sending) {
        messages = messages.filter((m) => m.id !== placeholderId || m.content);
      }
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      if (!streamedText) {
        messages = messages.filter((m) => m.id !== placeholderId);
      }
      sending = false;
      progressHint = null;
      cleanupActiveStream?.();
      cleanupActiveStream = null;
      if (responseRunId) clearActiveRun(responseRunId);
    }
  }

  function previewFromDraftIntent(intent: DashboardDraftIntent): { view: DashboardViewDTO; cache?: DashboardCacheDTO } {
    const draft = intent.draft;
    return {
      view: {
        id: "__ai_draft__",
        workspaceId: draft.workspaceId,
        workbookId: draft.workbookId,
        title: intent.title,
        slug: "ai-draft",
        description: intent.description,
        queryMode: draft.queryMode,
        viewType: draft.viewType,
        resultContract: draft.resultContract,
        status: "draft",
        compiledSql: intent.preview?.sql ?? draft.compiledSql ?? "",
        builderSpec: draft.builderSpec,
        displaySpec: draft.displaySpec ?? {},
        sourceTables: intent.preview?.sourceTables ?? draft.builderSpec?.sourceTables ?? [],
        dependencies: intent.preview?.dependencies ?? draft.builderSpec?.sourceTables ?? [],
        version: 0,
      },
      cache: intent.preview ? {
        viewId: "__ai_draft__",
        status: "ok",
        rowsCount: intent.preview.rowsCount,
        durationMs: intent.preview.durationMs,
        executedAt: new Date().toISOString(),
        sqlHash: intent.preview.sqlHash,
        result: intent.preview.result,
        resultMeta: intent.preview.resultMeta,
      } : undefined,
    };
  }
</script>

{#if appState.aiDrawerOpen}
  <aside class="ai-sidecar" aria-label="AI 助手">
    <header>
      <div class="header-copy">
        <strong>AI</strong>
        <span>让数据、表格和仪表盘保持在同一段上下文里</span>
      </div>
      <div class="header-actions">
        <button class="icon-btn" aria-label="关闭 AI 助手" onclick={() => appState.setAiDrawerOpen(false)}>
          <Icon name="x" size={16} />
        </button>
      </div>
    </header>

    <div class="quick-actions">
      <button onclick={() => navigate("dashboard")}>
        <Icon name="coins" size={15} />
        打开仪表盘
      </button>
      <button onclick={() => useExample("查找某个债权人或债权数据")}>
        <Icon name="search" size={15} />
        查找数据
      </button>
      <button onclick={() => useExample("根据当前数据创建一个统计图表")}>
        <Icon name="ai" size={15} />
        创建图表
      </button>
    </div>

    {#if progressHint}
      <div class="progress-hint" aria-live="polite">{progressHint}</div>
    {/if}

    <div class="conversation">
      {#if messages.length}
        <div class="message-list">
          {#each messages as message (message.id)}
            <article class="message" class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}>
              {#if message.role === "assistant" && !message.content && sending}
                <p class="typing"><span></span><span></span><span></span></p>
              {:else if message.role === "assistant"}
                <div class="md-content">{@html renderMarkdown(message.content)}</div>
              {:else}
                <p class="user-text">{message.content}</p>
              {/if}
            </article>

            {#each pendingIntents.filter((p) => p.messageId === message.id && !p.dismissed) as pending (pending.messageId)}
              <div class="intent-card">
                {#if pending.intent.type === "navigate"}
                  <span class="intent-label">跳转到：{pending.intent.route}</span>
                  <div class="intent-actions">
                    <button class="confirm-btn" onclick={() => { void confirmNavigationIntent(pending.intent, pending.messageId, pending.runId); }}>跳转</button>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>忽略</button>
                  </div>
                {:else if pending.intent.type === "open-workbook"}
                  <span class="intent-label">打开工作簿：{pending.intent.label}</span>
                  <div class="intent-actions">
                    <button class="confirm-btn" onclick={() => { void confirmNavigationIntent(pending.intent, pending.messageId, pending.runId); }}>打开</button>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>忽略</button>
                  </div>
                {:else if pending.intent.type === "open-dashboard"}
                  <span class="intent-label">打开仪表盘：{pending.intent.label}</span>
                  <div class="intent-actions">
                    <button class="confirm-btn" onclick={() => { void confirmNavigationIntent(pending.intent, pending.messageId, pending.runId); }}>打开</button>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>忽略</button>
                  </div>
                {:else if pending.intent.type === "open-record"}
                  <span class="intent-label">定位记录：{pending.intent.label}</span>
                  <div class="intent-actions">
                    <button class="confirm-btn" onclick={() => { void confirmNavigationIntent(pending.intent, pending.messageId, pending.runId); }}>定位</button>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>忽略</button>
                  </div>
                {:else if pending.intent.type === "ambiguous"}
                  {#if pending.suspendKind === "resource-candidates"}
                    {@const selectedResources = resourceSelectionFor(pending.messageId)}
                    <span class="intent-label">找到 {pending.intent.candidates.length} 条可能相关资源</span>
                    <div class="intent-candidates resource-candidates">
                      {#each pending.intent.candidates as candidate (candidate.id)}
                        {@const selected = isResourceCandidateSelected(pending.messageId, candidate.id)}
                        <button class="resource-candidate-btn" class:selected onclick={() => toggleResourceCandidate(pending.messageId, candidate.id)}>
                          <span class="resource-candidate-check">{#if selected}<Icon name="check" size={12} />{/if}</span>
                          <span class="resource-candidate-main">
                            <strong>{candidate.label}</strong>
                            {#if candidate.summary}<span>{candidate.summary}</span>{/if}
                            <small>
                              {#if candidate.score !== undefined}{Math.round(candidate.score * 100)} 分{/if}
                              {#if candidate.resourceType} · {candidate.resourceType}{/if}
                            </small>
                          </span>
                        </button>
                      {/each}
                    </div>
                    <div class="intent-actions">
                      <button class="confirm-btn" disabled={!selectedResources.size} onclick={() => { void answerWithSelectedResources(pending); }}>用选中资源回答</button>
                      <button class="secondary-btn" onclick={() => { void continueResourceResearch(pending); }}>继续人工检索</button>
                      <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>关闭</button>
                    </div>
                  {:else}
                    <span class="intent-label">找到 {pending.intent.candidates.length} 条匹配结果，请选择：</span>
                    <div class="intent-candidates">
                      {#each pending.intent.candidates as candidate (candidate.id)}
                        <button class="candidate-btn" onclick={() => { void chooseAmbiguousCandidate(pending, candidate.id); }}>
                          {candidate.label}
                        </button>
                      {/each}
                    </div>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>关闭</button>
                  {/if}
                {:else if pending.intent.type === "row-patch-proposal"}
                  {@const acceptedFields = acceptedFieldsForRowPatch(pending.messageId, pending.intent)}
                  <div class="draft-head">
                    <span class="intent-label">字段补全提案</span>
                    <p>{pending.intent.proposals.length} 个建议字段，确认后写入当前记录。</p>
                  </div>
                  <div class="row-patch-list">
                    {#each pending.intent.proposals as proposal (proposal.field)}
                      {@const accepted = isRowPatchFieldAccepted(pending.messageId, pending.intent, proposal.field)}
                      <section class="row-patch-item" class:ignored={!accepted} data-confidence={proposal.confidence}>
                        <div class="row-patch-top">
                          <strong>{proposal.field}</strong>
                          <span class="confidence" data-confidence={proposal.confidence}>{confidenceLabel(proposal.confidence)}</span>
                        </div>
                        <div class="patch-values">
                          <span>{formatPatchValue(proposal.currentValue)}</span>
                          <Icon name="arrowRight" size={13} />
                          <span>{formatPatchValue(proposal.suggestedValue)}</span>
                        </div>
                        <p>{proposal.basis}</p>
                        <div class="field-choice">
                          <button class:active={accepted} onclick={() => setRowPatchFieldAccepted(pending.messageId, pending.intent, proposal.field, true)}>接受</button>
                          <button class:active={!accepted} onclick={() => setRowPatchFieldAccepted(pending.messageId, pending.intent, proposal.field, false)}>忽略</button>
                        </div>
                      </section>
                    {/each}
                  </div>
                  <div class="intent-actions">
                    <button class="confirm-btn" disabled={savingIntentId === pending.messageId || !acceptedFields.size} onclick={() => { void confirmRowPatchProposalIntent(pending.intent, pending.messageId, pending.runId); }}>
                      {savingIntentId === pending.messageId ? "写入中" : "确认写入"}
                    </button>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>全部忽略</button>
                  </div>
                {:else if pending.intent.type === "dashboard-draft"}
                  {@const preview = previewFromDraftIntent(pending.intent)}
                  {@const registration = getDashboardWidget(preview.view.viewType)}
                  <div class="draft-head">
                    <span class="intent-label">{pending.intent.title}</span>
                    <p>{pending.intent.explanation}</p>
                  </div>
                  <div class="draft-preview">
                    {#if pending.intent.preview && registration}
                      {@const WidgetComponent = registration.component}
                      <WidgetComponent view={preview.view} cache={preview.cache} />
                    {:else}
                      <div class="draft-spec">
                        <strong>{preview.view.viewType}</strong>
                        <span>{pending.intent.widgetSpec.baseTable}</span>
                        <code>{JSON.stringify(pending.intent.widgetSpec.metric)}</code>
                      </div>
                    {/if}
                  </div>
                  <div class="intent-actions">
                    <button class="confirm-btn" disabled={savingIntentId === pending.messageId} onclick={() => { void confirmDashboardDraftIntent(pending.intent, pending.messageId, pending.runId); }}>
                      {savingIntentId === pending.messageId ? "保存中" : "保存到仪表盘"}
                    </button>
                    <button class="dismiss-btn" onclick={() => dismissIntent(pending.messageId)}>忽略</button>
                  </div>
                {/if}
              </div>
            {/each}
          {/each}
        </div>
      {:else}
        <div class="empty">
          <span class="empty-icon"><Icon name="ai" size={22} /></span>
          <strong>从当前页面开始</strong>
          <span>可直接查找工作簿、定位记录、创建统计，AI 会带上页面上下文。</span>
        </div>
      {/if}
    </div>

    <form class="composer" onsubmit={(event) => { event.preventDefault(); sendPrompt(); }}>
      {#if sendError}
        <p class="send-error">{sendError}</p>
      {/if}
      <div class="composer-context" aria-label="当前上下文">
        {#each contextTags() as tag}
          <span title={tag}>{tag}</span>
        {/each}
      </div>
      <textarea bind:value={prompt} rows="3" placeholder="例如：帮我找到某某债权，或按案件状态统计确认金额"></textarea>
      <div class="composer-actions">
        {#if activeRun}
          <button
            type="button"
            class="cancel-run-btn"
            disabled={cancellingRun}
            onclick={() => { void terminateActiveRun(); }}
          >
            <Icon name="x" size={14} />
            {cancellingRun ? "终止中" : "终止"}
          </button>
        {/if}
        <div class="send-split">
          <button class="primary-btn composer-send-btn" disabled={!prompt.trim() || sending || !!activeRun}>
            <Icon name={activeComposerMode.icon} size={15} color="#fff" />
            {sending ? (composerMode === "resource-search" ? "搜索中" : "发送中") : activeComposerMode.label}
          </button>
          <button
            type="button"
            class="send-mode-toggle"
            aria-label="切换发送模式"
            aria-expanded={composerMenuOpen}
            disabled={sending || !!activeRun}
            onclick={() => (composerMenuOpen = !composerMenuOpen)}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          {#if composerMenuOpen}
            <div class="send-mode-menu" role="menu">
              <button type="button" role="menuitem" class:active={composerMode === "chat"} onclick={() => setComposerMode("chat")}>
                <Icon name="send" size={14} />
                发送消息
              </button>
              <button type="button" role="menuitem" class:active={composerMode === "resource-search"} onclick={() => setComposerMode("resource-search")}>
                <Icon name="search" size={14} />
                搜索资源
              </button>
            </div>
          {/if}
        </div>
      </div>
    </form>
  </aside>
{/if}


<style>
  .ai-sidecar {
    position: relative;
    z-index: 30;
    display: flex;
    flex-direction: column;
    width: min(420px, 34vw);
    height: 100%;
    min-width: 360px;
    flex: 0 0 auto;
    border-left: 1px solid var(--border);
    background:
      linear-gradient(180deg, rgba(248, 250, 252, .96), var(--surface) 220px),
      var(--surface);
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--border);
  }

  .header-copy {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  header strong {
    color: var(--text-1);
    font-size: 16px;
    letter-spacing: 0;
  }

  header span {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.5;
  }

  .header-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .quick-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    height: 36px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--soft);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
    white-space: nowrap;
    box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  }

  .quick-actions button:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .conversation {
    display: flex;
    flex: 1;
    min-height: 0;
    align-items: stretch;
    justify-content: stretch;
    padding: 18px 20px;
    overflow: auto;
  }

  .progress-hint {
    padding: 6px 20px;
    border-bottom: 1px solid var(--border);
    background: rgba(22, 100, 255, .04);
    color: var(--primary);
    font-size: 12px;
    line-height: 1.5;
  }

  .message-list {
    display: grid;
    align-self: stretch;
    align-content: start;
    width: 100%;
    gap: 14px;
  }

  .message {
    display: grid;
    width: min(100%, 360px);
    gap: 0;
    padding: 12px 14px;
    border: 1px solid rgba(203, 213, 225, .9);
    border-radius: 8px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  }

  .user-message {
    justify-self: end;
    background: #eef4ff;
    border-color: #d7e4ff;
  }

  .assistant-message {
    justify-self: start;
    background: var(--surface);
    border-left: 3px solid var(--primary);
  }

  .composer-context {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    min-width: 0;
  }

  .composer-context span {
    max-width: 100%;
    overflow: hidden;
    padding: 2px 7px;
    border: 1px solid rgba(148, 163, 184, .28);
    border-radius: 999px;
    background: rgba(248, 250, 252, .78);
    color: #64748b;
    font-size: 11px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-text {
    margin: 0;
    color: var(--text-1);
    font-size: 13.5px;
    line-height: 1.65;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .md-content {
    color: var(--text-1);
    font-size: 13.5px;
    line-height: 1.65;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .md-content :global(p) {
    margin: 0 0 0.6em;
  }

  .md-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .md-content :global(h1),
  .md-content :global(h2),
  .md-content :global(h3),
  .md-content :global(h4) {
    margin: 0.8em 0 0.3em;
    font-weight: 650;
    line-height: 1.3;
  }

  .md-content :global(h1) { font-size: 15px; }
  .md-content :global(h2) { font-size: 14px; }
  .md-content :global(h3) { font-size: 13.5px; }

  .md-content :global(ul),
  .md-content :global(ol) {
    margin: 0.4em 0;
    padding-left: 1.4em;
  }

  .md-content :global(li) {
    margin-bottom: 0.2em;
  }

  .md-content :global(code) {
    padding: 0.1em 0.4em;
    border-radius: 4px;
    background: rgba(15, 23, 42, .07);
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }

  .md-content :global(pre) {
    margin: 0.5em 0;
    padding: 10px 12px;
    border-radius: 6px;
    background: rgba(15, 23, 42, .06);
    overflow-x: auto;
  }

  .md-content :global(pre code) {
    padding: 0;
    background: transparent;
    font-size: 12px;
  }

  .md-content :global(blockquote) {
    margin: 0.5em 0;
    padding: 0 0 0 10px;
    border-left: 3px solid var(--border);
    color: var(--text-3);
  }

  .md-content :global(hr) {
    margin: 0.7em 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .md-content :global(a) {
    color: var(--primary);
    text-decoration: none;
  }

  .md-content :global(a:hover) {
    text-decoration: underline;
  }

  .md-content :global(strong) {
    font-weight: 650;
  }

  .md-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin: 0.5em 0;
  }

  .md-content :global(th),
  .md-content :global(td) {
    padding: 4px 8px;
    border: 1px solid var(--border);
    text-align: left;
  }

  .md-content :global(th) {
    background: rgba(15, 23, 42, .04);
    font-weight: 600;
  }

  .typing {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    height: 18px;
  }

  .typing span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-3);
    animation: ai-typing 1.1s infinite ease-in-out;
  }

  .typing span:nth-child(2) { animation-delay: .15s; }
  .typing span:nth-child(3) { animation-delay: .3s; }

  @keyframes ai-typing {
    0%, 60%, 100% { opacity: .3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-2px); }
  }

  .empty {
    display: grid;
    max-width: 280px;
    margin: auto;
    justify-items: center;
    gap: 10px;
    color: var(--text-3);
    text-align: center;
  }

  .empty-icon {
    display: inline-grid;
    width: 42px;
    height: 42px;
    place-items: center;
    border: 1px solid #dbeafe;
    border-radius: 8px;
    background: #eff6ff;
    color: var(--primary);
  }

  .empty strong {
    color: var(--text-1);
    font-size: 14px;
  }

  .empty span {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.7;
  }

  .composer {
    display: grid;
    gap: 10px;
    padding: 14px 20px 18px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .send-error {
    margin: 0;
    color: var(--danger, #c2410c);
    font-size: 12px;
    line-height: 1.5;
  }

  textarea {
    width: 100%;
    min-height: 92px;
    resize: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 13px;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
    outline: none;
    box-shadow: inset 0 1px 2px rgba(15, 23, 42, .03);
  }

  textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(22, 100, 255, .08);
  }

  .composer-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .cancel-run-btn {
    display: inline-flex;
    height: 36px;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    border: 1px solid #fecaca;
    border-radius: 7px;
    background: #fff5f5;
    color: #b91c1c;
    font-size: 12px;
    font-weight: 650;
  }

  .cancel-run-btn:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  .send-split {
    position: relative;
    display: inline-grid;
    grid-template-columns: auto 34px;
    align-items: stretch;
  }

  .composer .composer-send-btn {
    height: 36px;
    min-width: 112px;
    padding: 0 14px;
    border-radius: 7px 0 0 7px;
  }

  .send-mode-toggle {
    display: inline-grid;
    height: 36px;
    place-items: center;
    border: 0;
    border-left: 1px solid rgba(255, 255, 255, .32);
    border-radius: 0 7px 7px 0;
    background: var(--primary);
    color: #fff;
  }

  .send-mode-toggle:hover {
    background: var(--primary-hover);
  }

  .send-mode-toggle:disabled {
    cursor: not-allowed;
    opacity: .45;
  }

  .send-mode-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 2;
    display: grid;
    min-width: 142px;
    gap: 4px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 12px 28px rgba(15, 23, 42, .14);
  }

  .send-mode-menu button {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    height: 30px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
    white-space: nowrap;
  }

  .send-mode-menu button:hover,
  .send-mode-menu button.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .composer .composer-send-btn:disabled {
    cursor: not-allowed;
    opacity: .45;
  }

  @media (max-width: 640px) {
    .quick-actions {
      grid-template-columns: 1fr;
    }

    .ai-sidecar {
      position: fixed;
      top: 12px;
      left: 12px;
      right: 12px;
      bottom: 12px;
      width: auto;
      min-width: 0;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
  }

  .intent-card {
    display: grid;
    gap: 8px;
    width: min(100%, 360px);
    padding: 10px 12px;
    border: 1px solid var(--primary);
    border-radius: 8px;
    background: var(--primary-light, rgba(22, 100, 255, .06));
  }

  .draft-head {
    display: grid;
    gap: 6px;
  }

  .draft-head p {
    margin: 0;
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.5;
  }

  .draft-preview {
    min-height: 180px;
    max-height: 260px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: #fff;
  }

  .draft-spec {
    display: grid;
    gap: 8px;
    color: var(--text-2);
    font-size: 12px;
  }

  .draft-spec code {
    white-space: normal;
    overflow-wrap: anywhere;
    color: var(--text-3);
  }

  .row-patch-list {
    display: grid;
    gap: 8px;
  }

  .row-patch-item {
    display: grid;
    gap: 7px;
    padding: 9px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: #fff;
  }

  .row-patch-item.ignored {
    opacity: .62;
  }

  .row-patch-top,
  .patch-values,
  .field-choice {
    display: flex;
    align-items: center;
  }

  .row-patch-top {
    justify-content: space-between;
    gap: 8px;
  }

  .row-patch-top strong {
    min-width: 0;
    overflow: hidden;
    color: var(--text-1);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .confidence {
    flex: 0 0 auto;
    padding: 2px 6px;
    border-radius: 6px;
    background: #ecfdf5;
    color: #047857;
    font-size: 11px;
  }

  .confidence[data-confidence="medium"] {
    background: #fffbeb;
    color: #b45309;
  }

  .confidence[data-confidence="low"] {
    background: #fef2f2;
    color: #b91c1c;
  }

  .patch-values {
    gap: 6px;
    color: var(--text-2);
    font-size: 12px;
  }

  .patch-values span {
    min-width: 0;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .patch-values span:last-child {
    color: var(--text-1);
    font-weight: 550;
  }

  .row-patch-item p {
    margin: 0;
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.5;
  }

  .field-choice {
    gap: 4px;
  }

  .field-choice button {
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fff;
    color: var(--text-3);
    font-size: 12px;
  }

  .field-choice button.active {
    border-color: var(--primary);
    background: var(--primary-light, rgba(22, 100, 255, .06));
    color: var(--primary);
  }

  .intent-label {
    color: var(--text-1);
    font-size: 12px;
    font-weight: 550;
  }

  .intent-actions {
    display: flex;
    gap: 6px;
  }

  .intent-candidates {
    display: grid;
    gap: 4px;
  }

  .candidate-btn {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    text-align: left;
  }

  .candidate-btn:hover {
    border-color: var(--primary);
    background: var(--primary-light, rgba(22, 100, 255, .06));
  }

  .resource-candidates {
    gap: 6px;
  }

  .resource-candidate-btn {
    width: 100%;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    text-align: left;
  }

  .resource-candidate-btn.selected {
    border-color: var(--primary);
    background: var(--primary-light, rgba(22, 100, 255, .06));
  }

  .resource-candidate-check {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--primary);
  }

  .resource-candidate-btn.selected .resource-candidate-check {
    border-color: var(--primary);
    background: #fff;
  }

  .resource-candidate-main {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .resource-candidate-main strong,
  .resource-candidate-main span,
  .resource-candidate-main small {
    overflow-wrap: anywhere;
  }

  .resource-candidate-main strong {
    font-size: 12px;
    font-weight: 650;
  }

  .resource-candidate-main span,
  .resource-candidate-main small {
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.35;
  }

  .confirm-btn {
    height: 28px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
    font-weight: 550;
  }

  .confirm-btn:hover {
    background: var(--primary-hover);
  }

  .confirm-btn:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  .secondary-btn {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    font-weight: 550;
  }

  .secondary-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .dismiss-btn {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
  }

  .dismiss-btn:hover {
    color: var(--text-1);
    border-color: var(--text-3);
  }
</style>
