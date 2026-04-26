<script lang="ts">
  import EmptyState from "../components/EmptyState.svelte";
  import FileIcon from "../components/FileIcon.svelte";
  import Icon from "../components/Icon.svelte";
  import { appApi } from "../lib/app-api";
  import { appState } from "../lib/app-state.svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import type { Navigate } from "../lib/types";
  import type { TemplateSummaryDTO } from "../../../shared/rpc.types";

  let { navigate }: { navigate: Navigate } = $props();

  let templates = $state<TemplateSummaryDTO[]>([]);
  let selected = $state<TemplateSummaryDTO | null>(null);
  let loading = $state(true);
  let creating = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    void loadTemplates();
  });

  async function loadTemplates() {
    loading = true;
    const res = await appApi.listTemplates();
    loading = false;
    if (res.ok) {
      templates = res.data.templates;
      selected = templates[0] ?? null;
    } else {
      error = res.message;
    }
  }

  async function handleCreate() {
    if (!selected || !appState.workspace || appState.readOnly) return;
    creating = true;
    error = null;
    const wb = await workbooksStore.createFromTemplate(appState.workspace.id, selected.key);
    creating = false;
    if (wb) {
      navigate("editor", { workbookId: wb.id });
    } else {
      error = workbooksStore.error ?? "创建失败";
    }
  }
</script>

<section class="templates">
  <div class="list">
    <header>
      <button class="ghost-btn" onclick={() => navigate("home")}><Icon name="chevronLeft" size={14} />返回首页</button>
      <h1>从模板创建</h1>
    </header>

    {#if loading}
      <div class="state-msg">加载中…</div>
    {:else if error}
      <div class="state-msg err">{error}</div>
    {:else}
      <div class="grid">
        {#each templates as template}
          <button class:selected={selected?.key === template.key} onclick={() => (selected = template)}>
            <FileIcon type="excel" size={32} />
            <strong>{template.name}</strong>
            <span>{template.description}</span>
            <div>{#each template.tags as tag}<em>{tag}</em>{/each}</div>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <aside>
    {#if selected}
      <FileIcon type="excel" size={40} />
      <h2>{selected.name}</h2>
      <p>{selected.description}</p>
      <hr />
      <small>标签</small>
      <span>{selected.tags.join(" · ")}</span>
      <button
        class="primary-btn"
        onclick={handleCreate}
        disabled={creating || appState.readOnly}
      >
        {creating ? "创建中…" : "使用此模板创建"}
      </button>
      {#if appState.readOnly}
        <small class="ro-hint">离线模式，创建不可用</small>
      {/if}
    {:else}
      <EmptyState icon="tag" title="选择模板" desc="点击左侧模板卡片预览详情" />
    {/if}
  </aside>
</section>

<style>
  .templates {
    display: flex;
    flex: 1;
    overflow: hidden;
    background: var(--bg);
  }

  .list {
    flex: 1;
    overflow: auto;
    padding: 28px 32px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  h1,
  h2 {
    margin: 0;
    color: var(--text-1);
  }

  h1 {
    font-size: 18px;
  }

  h2 {
    margin-top: 12px;
    font-size: 15px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 14px;
  }

  .grid button {
    display: flex;
    min-height: 164px;
    flex-direction: column;
    gap: 8px;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    text-align: left;
  }

  .grid button:hover,
  .grid button.selected {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .grid span,
  aside p,
  aside > span {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.6;
  }

  .grid div {
    display: flex;
    gap: 4px;
    margin-top: auto;
  }

  em {
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg);
    color: var(--text-3);
    font-size: 10px;
    font-style: normal;
  }

  aside {
    display: flex;
    width: 260px;
    flex-shrink: 0;
    flex-direction: column;
    padding: 24px 20px;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }

  hr {
    width: 100%;
    margin: 16px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }

  aside small {
    color: var(--text-3);
    font-size: 11px;
  }

  aside button {
    margin-top: auto;
    padding: 11px 0;
  }

  aside button:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .ro-hint {
    margin-top: 6px;
    color: var(--warning);
    font-size: 11px;
    text-align: center;
  }

  .state-msg {
    padding: 48px 0;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
  }

  .state-msg.err {
    color: var(--error);
  }
</style>
