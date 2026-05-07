<script lang="ts">
  import { buildAiContextSnapshot, createAiUserMessage } from "../../shared/ai-context";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { appApi } from "../lib/app-api";
  import { appState } from "../lib/app-state.svelte";
  import { editorStore } from "../lib/editor.svelte";
  import { subscribeAiChunks } from "../lib/rpc";
  import Icon from "./Icon.svelte";
  import type { AiChatMessage } from "../../shared/ai-context";
  import type { Navigate, RouteState } from "../lib/types";

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

  function patchMessage(id: string, patch: Partial<AiChatMessage>) {
    messages = messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
  }

  function replaceOrAppendAssistantMessage(placeholderId: string, message: AiChatMessage) {
    const found = messages.some((m) => m.id === placeholderId);
    if (found) {
      patchMessage(placeholderId, message);
    } else {
      messages = [...messages, message];
    }
  }

  async function sendPrompt() {
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

    messages = [...messages, message, placeholder];
    prompt = "";
    sending = true;
    sendError = null;
    let streamedText = "";

    const unsubscribe = subscribeAiChunks(streamId, (event) => {
      if (event.type === "delta") {
        streamedText += event.text;
        const current = messages.find((m) => m.id === placeholderId);
        if (!current) return;
        patchMessage(placeholderId, { content: current.content + event.text });
      } else if (event.type === "error") {
        sendError = event.message;
        sending = false;
        unsubscribe();
      } else if (event.type === "done") {
        replaceOrAppendAssistantMessage(placeholderId, event.message);
        sending = false;
        unsubscribe();
      }
    });

    try {
      const res = await appApi.sendAiMessage(message, streamId);
      if (res.ok && res.data.message.content) {
        replaceOrAppendAssistantMessage(placeholderId, {
          id: res.data.message.id,
          content: res.data.message.content,
          role: res.data.message.role,
          createdAt: res.data.message.createdAt,
          context: res.data.message.context,
        });
      } else if (!res.ok && streamedText) {
        patchMessage(placeholderId, { content: streamedText });
        sendError = res.message;
        sending = false;
        unsubscribe();
      } else if (!res.ok) {
        sendError = res.message;
        messages = messages.filter((m) => m.id !== placeholderId);
        sending = false;
        unsubscribe();
      }
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      if (!streamedText) {
        messages = messages.filter((m) => m.id !== placeholderId);
      }
      sending = false;
      unsubscribe();
    }
  }
</script>

{#if appState.aiDrawerOpen}
  <aside class="ai-sidecar" aria-label="AI 助手">
    <header>
      <div>
        <strong>AI 助手</strong>
        <span>{contextSnapshot.contextHint}</span>
      </div>
      <button class="icon-btn" aria-label="关闭 AI 助手" onclick={() => appState.setAiDrawerOpen(false)}>
        <Icon name="x" size={16} />
      </button>
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

    <div class="conversation">
      {#if messages.length}
        <div class="message-list">
          {#each messages as message (message.id)}
            <article class="message" class:assistant-message={message.role === "assistant"}>
              <div class="message-meta">
                <span>{message.role === "assistant" ? "AI 助手" : "你"}</span>
                <small>{message.context.contextHint}</small>
              </div>
              {#if message.role === "assistant" && !message.content && sending}
                <p class="typing"><span></span><span></span><span></span></p>
              {:else}
                <p>{message.content}</p>
              {/if}
            </article>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <Icon name="chat" size={22} />
          <strong>先从导航、查找、统计开始</strong>
          <span>后续这里会接入 Mastra agent，用受控工具访问 SurrealDB、仪表盘和表格数据。</span>
        </div>
      {/if}
    </div>

    <form class="composer" onsubmit={(event) => { event.preventDefault(); sendPrompt(); }}>
      {#if sendError}
        <p class="send-error">{sendError}</p>
      {/if}
      <textarea bind:value={prompt} rows="3" placeholder="例如：帮我找到某某债权，或按案件状态统计确认金额"></textarea>
      <button class="primary-btn" disabled={!prompt.trim() || sending}>
        <Icon name="send" size={15} color="#fff" />
        {sending ? "发送中" : "发送"}
      </button>
    </form>
  </aside>
{/if}

<button class="ai-launcher" aria-label="打开 AI 助手" title="AI 助手" onclick={() => appState.toggleAiDrawer()}>
  <Icon name="ai" size={20} color="#fff" />
</button>

<style>
  .ai-launcher {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 80;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 8px;
    background: var(--primary);
    box-shadow: 0 10px 24px rgba(22, 100, 255, .26);
  }

  .ai-launcher:hover {
    background: var(--primary-hover);
  }

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
    background: var(--surface);
    box-shadow: -10px 0 24px rgba(15, 23, 42, .08);
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  header div {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  header strong {
    color: var(--text-1);
    font-size: 15px;
  }

  header span {
    color: var(--text-3);
    font-size: 12px;
  }

  header .icon-btn {
    margin-left: auto;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .quick-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    height: 34px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--soft);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
    white-space: nowrap;
  }

  .quick-actions button:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .conversation {
    display: flex;
    flex: 1;
    min-height: 0;
    align-items: center;
    justify-content: center;
    padding: 20px;
    overflow: auto;
  }

  .message-list {
    display: grid;
    align-self: stretch;
    width: 100%;
    gap: 10px;
  }

  .message {
    display: grid;
    justify-self: end;
    width: min(100%, 320px);
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--primary-light);
  }

  .assistant-message {
    justify-self: start;
    background: var(--surface);
  }

  .message-meta {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .message-meta span {
    color: var(--text-1);
    font-size: 12px;
    font-weight: 650;
  }

  .message-meta small {
    overflow: hidden;
    color: var(--text-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message p {
    margin: 0;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.6;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
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
    justify-items: center;
    gap: 8px;
    color: var(--text-3);
    text-align: center;
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
    padding: 14px 16px 16px;
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
    min-height: 78px;
    resize: none;
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 11px;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
    outline: none;
  }

  textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(22, 100, 255, .08);
  }

  .composer .primary-btn {
    height: 34px;
    justify-self: end;
    padding: 0 14px;
  }

  .composer .primary-btn:disabled {
    cursor: not-allowed;
    opacity: .45;
  }

  @media (max-width: 640px) {
    .ai-launcher {
      right: 16px;
      bottom: 16px;
    }

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
</style>
