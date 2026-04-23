<script lang="ts">
  import EmptyState from "../components/EmptyState.svelte";
  import FileIcon from "../components/FileIcon.svelte";
  import Icon from "../components/Icon.svelte";
  import { templates } from "../lib/mock";
  import type { Navigate, TemplateItem } from "../lib/types";

  let { navigate }: { navigate: Navigate } = $props();
  let selected = $state<TemplateItem | null>(templates[0]);
</script>

<section class="templates">
  <div class="list">
    <header>
      <button class="ghost-btn" onclick={() => navigate("home")}><Icon name="chevronLeft" size={14} />返回首页</button>
      <h1>从模板创建</h1>
    </header>
    <div class="grid">
      {#each templates as template}
        <button class:selected={selected?.id === template.id} onclick={() => (selected = template)}>
          <FileIcon type="excel" size={32} />
          <strong>{template.name}</strong>
          <span>{template.desc}</span>
          <div>{#each template.tags as tag}<em>{tag}</em>{/each}</div>
        </button>
      {/each}
    </div>
  </div>

  <aside>
    {#if selected}
      <FileIcon type="excel" size={40} />
      <h2>{selected.name}</h2>
      <p>{selected.desc}</p>
      <hr />
      <small>适用场景</small>
      <span>破产重整 · 债务清算 · 资产处置</span>
      <button class="primary-btn" onclick={() => navigate("editor")}>使用此模板创建</button>
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
</style>
