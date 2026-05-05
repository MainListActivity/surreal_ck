<script lang="ts">
  import { buildAiContextSnapshot } from "../../shared/ai-context";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { editorStore } from "../lib/editor.svelte";
  import Icon from "./Icon.svelte";
  import type { Navigate, RouteState } from "../lib/types";

  let {
    route,
    navigate,
  }: {
    route: RouteState;
    navigate: Navigate;
  } = $props();

  let open = $state(false);
  let prompt = $state("");

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
</script>

{#if open}
  <aside class="ai-sidecar" aria-label="AI 助手">
    <header>
      <div>
        <strong>AI 助手</strong>
        <span>{contextSnapshot.contextHint}</span>
      </div>
      <button class="icon-btn" aria-label="关闭 AI 助手" onclick={() => (open = false)}>
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
      <div class="empty">
        <Icon name="chat" size={22} />
        <strong>先从导航、查找、统计开始</strong>
        <span>后续这里会接入 Mastra agent，用受控工具访问 SurrealDB、仪表盘和表格数据。</span>
      </div>
    </div>

    <form class="composer" onsubmit={(event) => event.preventDefault()}>
      <textarea bind:value={prompt} rows="3" placeholder="例如：帮我找到某某债权，或按案件状态统计确认金额"></textarea>
      <button class="primary-btn" disabled={!prompt.trim()}>
        <Icon name="send" size={15} color="#fff" />
        发送
      </button>
    </form>
  </aside>
{/if}

<button class="ai-launcher" aria-label="打开 AI 助手" title="AI 助手" onclick={() => (open = true)}>
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
    position: fixed;
    top: 14px;
    right: 14px;
    bottom: 14px;
    z-index: 90;
    display: flex;
    flex-direction: column;
    width: min(420px, calc(100vw - 28px));
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(15, 23, 42, .18);
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
      left: 12px;
      right: 12px;
      width: auto;
    }
  }
</style>
