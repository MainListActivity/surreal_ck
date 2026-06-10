<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy } from "svelte";
  import { marked } from "marked";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { connectWs } from "../lib/ws";
  import { buildDrawerContextSnapshot } from "../lib/ai-context-source";
  import { editorStore } from "../lib/editor-store.svelte";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import {
    createAiDrawerSession,
    type AiDrawerContextSnapshot,
    type AiDrawerState,
    type ChatRunStart,
  } from "../lib/ai-drawer";
  import type { ChatStreamEvent, ResumeDecision } from "@surreal-ck/shared";

  type Props = {
    open?: boolean;
    workspaceSlug?: string | null;
    routeScreen?: string;
    onclose?: () => void;
  };

  let {
    open = true,
    workspaceSlug = null,
    routeScreen = "workspace",
    onclose,
  }: Props = $props();

  function emptyState(): AiDrawerState {
    return {
      messages: [],
      pendingIntents: [],
      toolCallsByMessageId: {},
      sending: false,
      sendError: null,
      progressHint: null,
      activeRun: null,
      workspaceSlug: null,
    };
  }

  let drawerState: AiDrawerState = $state(emptyState());
  let prompt: string = $state("");

  function resolveStreamUrl(streamUrl: string): string {
    if (streamUrl.startsWith("ws://") || streamUrl.startsWith("wss://")) return streamUrl;
    const env = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env;
    const base = env?.VITE_API_BASE_URL || globalThis.location?.origin || "http://localhost:8080";
    const absolute = new URL(streamUrl, base);
    absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
    return absolute.toString();
  }

  async function expectJson<T>(res: Response, fallback: string): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
      throw new Error(body?.error?.message ?? body?.error?.code ?? fallback);
    }
    return res.json() as Promise<T>;
  }

  const session = createAiDrawerSession({
    chatClient: {
      async startChat(input) {
        const res = await api.api.chat.$post({
          json: {
            message: input.message,
            contextSnapshot: input.contextSnapshot,
          },
        });
        return expectJson<ChatRunStart>(res, "AI 消息发送失败。");
      },
      async resumeChat(runId: string, decision: ResumeDecision) {
        const res = await api.api.chat.runs[":runId"].resume.$post({
          param: { runId },
          json: { runId, decision },
        });
        return expectJson<ChatRunStart>(res, "AI 会话续跑失败。");
      },
    },
    connectStream(input) {
      return connectWs({
        url: resolveStreamUrl(input.url),
        params: { streamToken: input.streamToken },
        onMessage(message) {
          input.onEvent(message as ChatStreamEvent);
        },
        onClose: input.onClose,
      });
    },
    onChange(next) {
      drawerState = next;
    },
  });

  $effect(() => {
    session.syncWorkspace(workspaceSlug);
    drawerState = session.snapshot();
  });

  onDestroy(() => {
    session.dispose();
  });

  /**
   * 发消息时从编辑器当前选择态构建完整快照——每次现算，不缓存，
   * 选择变化后发送的永远是当下状态，不会带陈旧快照。
   */
  function contextSnapshot(): AiDrawerContextSnapshot {
    return buildDrawerContextSnapshot({
      workspaceSlug,
      routeScreen,
      editor: {
        workbook: editorStore.workbook,
        sheets: editorStore.sheets,
        activeSheetId: editorStore.activeSheetId,
        rows: editorStore.rows,
        visibleColumns: editorStore.visibleColumns,
        selectedRowId: editorUi.selectedRowId,
      },
    });
  }

  // 头部提示与提交的快照走同一构建函数，保证「所见即所发」。
  const contextHint = $derived(contextSnapshot().contextHint);

  async function sendPrompt(): Promise<void> {
    const next = prompt;
    if (!next.trim()) return;
    prompt = "";
    await session.sendMessage(next, contextSnapshot());
  }

  function useExample(text: string): void {
    prompt = text;
  }

  function visiblePendingFor(messageId: string) {
    return drawerState.pendingIntents.filter((item: AiDrawerState["pendingIntents"][number]) =>
      item.messageId === messageId && !item.dismissed,
    );
  }

  marked.setOptions({ breaks: true });

  function sanitizeHtml(html: string): string {
    if (typeof document === "undefined") return html;
    const template = document.createElement("template");
    template.innerHTML = html;
    const blocked = template.content.querySelectorAll("script,style,iframe,object,embed,link,meta");
    blocked.forEach((node) => node.remove());
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const elements: Element[] = [];
    while (walker.nextNode()) elements.push(walker.currentNode as Element);
    for (const el of elements) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        if ((name === "href" || name === "src") && (value.startsWith("javascript:") || value.startsWith("data:text/html"))) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName.toLowerCase() === "a") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noreferrer");
      }
    }
    return template.innerHTML;
  }

  function renderMarkdown(text: string): string {
    return sanitizeHtml(marked.parse(text) as string);
  }
</script>

{#if open}
  <aside class="ai-drawer" aria-label="AI 助手">
    <header>
      <div class="header-copy">
        <strong>AI 助手</strong>
        <span title={contextHint}>{contextHint}</span>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭 AI 助手" onclick={() => onclose?.()}>
        <Icon name="x" size={16} />
      </button>
    </header>

    <div class="quick-actions">
      <button type="button" onclick={() => useExample("打开工作簿 X")}>
        <Icon name="spreadsheet" size={14} />工作簿
      </button>
      <button type="button" onclick={() => useExample("查找债权人或债权数据")}>
        <Icon name="search" size={14} />查找
      </button>
      <button type="button" onclick={() => useExample("根据当前数据创建统计图表")}>
        <Icon name="coins" size={14} />图表
      </button>
    </div>

    {#if drawerState.progressHint}
      <div class="progress-hint" aria-live="polite">{drawerState.progressHint}</div>
    {/if}

    <div class="conversation">
      {#if drawerState.messages.length === 0}
        <div class="empty">
          <span><Icon name="ai" size={22} /></span>
          <strong>当前上下文</strong>
          <small>{contextHint}</small>
        </div>
      {:else}
        <div class="message-list">
          {#each drawerState.messages as message (message.id)}
            <article class="message" class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}>
              {#if message.role === "assistant" && !message.content && drawerState.sending}
                <p class="typing"><span></span><span></span><span></span></p>
              {:else if message.role === "assistant"}
                <div class="md-content">{@html renderMarkdown(message.content)}</div>
                {#if message.citations?.length}
                  <ol class="citations" aria-label="引用">
                    {#each message.citations as citation (citation.index)}
                      <li>
                        {#if citation.sourceUrl}
                          <a href={citation.sourceUrl} target="_blank" rel="noreferrer">{citation.title}</a>
                        {:else}
                          <span>{citation.title}</span>
                        {/if}
                      </li>
                    {/each}
                  </ol>
                {/if}
                {@const toolCalls = drawerState.toolCallsByMessageId[message.id] ?? []}
                {#if toolCalls.length}
                  <details class="tool-trace">
                    <summary>Tool calls</summary>
                    {#each toolCalls as toolCall, index (`${toolCall.toolName}-${index}`)}
                      <code>{toolCall.toolName}</code>
                    {/each}
                  </details>
                {/if}
              {:else}
                <p class="user-text">{message.content}</p>
              {/if}
            </article>

            {#each visiblePendingFor(message.id) as pending (`${pending.messageId}-${pending.kind}`)}
              <div class="intent-card">
                {#if pending.kind === "ambiguous-candidates"}
                  <span>选择一个结果</span>
                  <div class="candidate-list">
                    {#each pending.candidates ?? [] as candidate (candidate.id)}
                      <button type="button" onclick={() => void session.chooseCandidate(pending.messageId, candidate.id)}>
                        <strong>{candidate.label}</strong>
                        {#if candidate.summary}<small>{candidate.summary}</small>{/if}
                      </button>
                    {/each}
                  </div>
                {:else if pending.kind === "resource-candidates"}
                  <span>选择资料</span>
                  <div class="candidate-list">
                    {#each pending.candidates ?? [] as candidate (candidate.id)}
                      <button type="button" onclick={() => void session.chooseCandidate(pending.messageId, candidate.id)}>
                        <strong>{candidate.label}</strong>
                        {#if candidate.summary}<small>{candidate.summary}</small>{/if}
                      </button>
                    {/each}
                  </div>
                {:else}
                  <span>等待确认</span>
                {/if}
              </div>
            {/each}
          {/each}
        </div>
      {/if}
    </div>

    <form class="composer" onsubmit={(event) => { event.preventDefault(); void sendPrompt(); }}>
      {#if drawerState.sendError}
        <p class="send-error">{drawerState.sendError}</p>
      {/if}
      <textarea
        bind:value={prompt}
        rows="3"
        placeholder="输入消息"
        disabled={drawerState.sending && !!drawerState.activeRun}
      ></textarea>
      <div class="composer-actions">
        <button type="submit" class="primary-btn" disabled={!prompt.trim() || (drawerState.sending && !!drawerState.activeRun)}>
          <Icon name="send" size={14} color="#fff" />{drawerState.sending ? "发送中" : "发送"}
        </button>
      </div>
    </form>
  </aside>
{/if}

<style>
  .ai-drawer {
    z-index: 30;
    display: flex;
    width: min(420px, 36vw);
    min-width: 360px;
    height: 100%;
    flex: 0 0 auto;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 18px 14px;
    border-bottom: 1px solid var(--border);
  }

  .header-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .header-copy strong {
    color: var(--text-1);
    font-size: 15px;
    letter-spacing: 0;
  }

  .header-copy span {
    overflow: hidden;
    color: var(--text-3);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  header .icon-btn {
    margin-left: auto;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }

  .quick-actions button {
    display: inline-flex;
    min-width: 0;
    height: 34px;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--soft);
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
    font-weight: 550;
    white-space: nowrap;
  }

  .progress-hint {
    padding: 7px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--primary-light);
    color: var(--primary);
    font-size: 12px;
    line-height: 1.45;
  }

  .conversation {
    display: flex;
    min-height: 0;
    flex: 1;
    padding: 16px 18px;
    overflow: auto;
  }

  .empty {
    display: grid;
    width: 100%;
    place-content: center;
    justify-items: center;
    gap: 6px;
    color: var(--text-3);
    font-size: 12px;
  }

  .empty strong {
    color: var(--text-2);
    font-size: 13px;
  }

  .message-list {
    display: grid;
    width: 100%;
    align-content: start;
    gap: 12px;
  }

  .message {
    display: grid;
    width: min(100%, 360px);
    gap: 8px;
    padding: 11px 13px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }

  .user-message {
    justify-self: end;
    border-color: #d7e4ff;
    background: #eef4ff;
  }

  .assistant-message {
    justify-self: start;
    border-left: 3px solid var(--primary);
  }

  .user-text,
  .md-content {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.6;
  }

  .user-text {
    white-space: pre-wrap;
  }

  .md-content :global(p) {
    margin: 0 0 0.55em;
  }

  .md-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .md-content :global(code) {
    padding: 0.1em 0.35em;
    border-radius: 4px;
    background: rgba(29, 33, 41, .08);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }

  .md-content :global(pre) {
    overflow-x: auto;
    margin: 0.5em 0;
    padding: 10px 12px;
    border-radius: 6px;
    background: rgba(29, 33, 41, .06);
  }

  .citations {
    display: grid;
    gap: 4px;
    margin: 2px 0 0;
    padding-left: 18px;
    color: var(--text-3);
    font-size: 12px;
  }

  .citations a {
    color: var(--primary);
    text-decoration: none;
  }

  .tool-trace {
    display: grid;
    gap: 6px;
    color: var(--text-3);
    font-size: 12px;
  }

  .tool-trace summary {
    cursor: pointer;
  }

  .tool-trace code {
    display: inline-flex;
    width: fit-content;
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--soft);
    color: var(--text-2);
    font-size: 11px;
  }

  .typing {
    display: inline-flex;
    height: 18px;
    align-items: center;
    gap: 4px;
    margin: 0;
  }

  .typing span {
    width: 5px;
    height: 5px;
    border-radius: 999px;
    animation: ai-typing 1.1s infinite ease-in-out;
    background: var(--text-3);
  }

  .typing span:nth-child(2) { animation-delay: .15s; }
  .typing span:nth-child(3) { animation-delay: .3s; }

  @keyframes ai-typing {
    0%, 60%, 100% { opacity: .35; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-2px); }
  }

  .intent-card {
    display: grid;
    width: min(100%, 360px);
    gap: 8px;
    justify-self: start;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--soft);
    color: var(--text-2);
    font-size: 12px;
  }

  .candidate-list {
    display: grid;
    gap: 6px;
  }

  .candidate-list button {
    display: grid;
    gap: 3px;
    min-width: 0;
    padding: 8px 9px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-1);
    cursor: pointer;
    text-align: left;
  }

  .candidate-list small {
    overflow-wrap: anywhere;
    color: var(--text-3);
    line-height: 1.4;
  }

  .composer {
    display: grid;
    gap: 8px;
    padding: 12px 18px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .send-error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
  }

  textarea {
    width: 100%;
    min-height: 76px;
    resize: vertical;
    padding: 10px 11px;
    border: 1px solid var(--border-dark);
    border-radius: 8px;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
  }

  textarea:focus {
    border-color: var(--primary);
    outline: none;
    box-shadow: 0 0 0 3px rgba(22, 100, 255, .12);
  }

  .composer-actions {
    display: flex;
    justify-content: flex-end;
  }

  .primary-btn {
    min-width: 86px;
    height: 34px;
    cursor: pointer;
  }

  .primary-btn:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  @media (max-width: 760px) {
    .ai-drawer {
      position: fixed;
      inset: 0 0 0 auto;
      width: min(100vw, 420px);
      min-width: 0;
      box-shadow: -20px 0 40px rgba(15, 23, 42, .14);
    }
  }
</style>
