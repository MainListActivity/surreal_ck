<script lang="ts">
  import FileIcon from "../components/FileIcon.svelte";
  import Icon from "../components/Icon.svelte";
  import { templateColors, workbooks } from "../lib/mock";
  import type { Navigate } from "../lib/types";

  let { navigate }: { navigate: Navigate } = $props();

  let query = $state("");
  let tab = $state("recent");
  let view = $state<"list" | "grid">("list");

  const filtered = $derived(workbooks.filter((wb) => !query || wb.name.includes(query) || wb.template.includes(query) || wb.modifier.includes(query)));
</script>

<section class="home">
  <header class="topbar">
    <label class="search" class:active={query}>
      <Icon name="search" size={14} color="var(--text-3)" />
      <input bind:value={query} placeholder="搜索工作簿、成员..." />
      {#if query}<button onclick={() => (query = "")}>×</button>{/if}
    </label>
    <button class="icon-btn" title="通知"><Icon name="bell" size={16} /></button>
  </header>

  <div class="content">
    {#if !query}
      <div class="quick-actions">
        <button><span><Icon name="plus" size={17} color="var(--primary)" /></span><strong>空白文档</strong><small>从零开始创建</small></button>
        <button onclick={() => navigate("templates")}><span><Icon name="tag" size={17} color="var(--primary)" /></span><strong>从模板创建</strong><small>债权申报·评估·汇总</small></button>
        <button><span><Icon name="upload" size={17} color="var(--primary)" /></span><strong>导入文件</strong><small>支持 Excel / CSV</small></button>
      </div>
    {/if}

    <div class="toolbar">
      <div class="tabs">
        {#each [{ id: "recent", label: "最近" }, { id: "mine", label: "我创建的" }, { id: "shared", label: "与我共享" }] as item}
          <button class:active={tab === item.id} onclick={() => (tab = item.id)}>{item.label}</button>
        {/each}
      </div>
      <div class="view-toggle">
        <button class:active={view === "list"} onclick={() => (view = "list")}><Icon name="list" size={15} /></button>
        <button class:active={view === "grid"} onclick={() => (view = "grid")}><Icon name="grid" size={15} /></button>
      </div>
    </div>

    {#if view === "list"}
      <div class="workbook-table">
        <div class="head"><span>名称</span><span>负责人</span><span>最近修改</span><span>模板类型</span></div>
        {#each filtered as wb}
          <button class="row" onclick={() => navigate("editor")}>
            <span class="name"><FileIcon type={wb.fileType} size={24} /><strong>{wb.name}</strong>{#if wb.pinned}<Icon name="pin" size={12} color="var(--text-3)" />{/if}</span>
            <span>{wb.modifier}</span>
            <span>{wb.modified}</span>
            <span><em style={`--tag:${templateColors[wb.template] ?? "var(--text-3)"}`}>{wb.template}</em></span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="workbook-grid">
        {#each filtered as wb}
          <button onclick={() => navigate("editor")}>
            <FileIcon type={wb.fileType} size={36} />
            <strong>{wb.name}</strong>
            <span>{wb.modified} · {wb.modifier}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .home {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }

  .topbar {
    display: flex;
    height: 44px;
    flex-shrink: 0;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .search {
    display: flex;
    max-width: 480px;
    height: 34px;
    flex: 1;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }

  .search:focus-within,
  .search.active {
    border-color: var(--primary);
    background: var(--surface);
  }

  input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-1);
    font-size: 13px;
  }

  .search button {
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 16px;
  }

  .content {
    flex: 1;
    overflow: auto;
    padding: 24px 28px;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 20px;
  }

  .quick-actions button,
  .workbook-grid button {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    text-align: left;
    transition: border-color .15s ease, box-shadow .15s ease;
  }

  .quick-actions button {
    display: grid;
    grid-template-columns: 36px 1fr;
    column-gap: 12px;
    padding: 14px 16px;
  }

  .quick-actions button:hover,
  .workbook-grid button:hover {
    border-color: var(--primary);
    box-shadow: 0 4px 14px rgba(22, 100, 255, .12);
  }

  .quick-actions span {
    display: grid;
    width: 36px;
    height: 36px;
    grid-row: span 2;
    place-items: center;
    border-radius: 9px;
    background: var(--primary-light);
  }

  strong {
    color: var(--text-1);
    font-size: 13px;
  }

  small,
  .workbook-grid span {
    color: var(--text-3);
    font-size: 11px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }

  .tabs {
    display: flex;
  }

  .tabs button {
    position: relative;
    height: 40px;
    padding: 0 14px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }

  .tabs button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .tabs button.active::after {
    position: absolute;
    right: 12px;
    bottom: 0;
    left: 12px;
    height: 2px;
    border-radius: 2px;
    background: var(--primary);
    content: "";
  }

  .view-toggle {
    display: flex;
    gap: 4px;
  }

  .view-toggle button {
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
  }

  .view-toggle button.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .workbook-table {
    border-top: 0;
  }

  .head,
  .row {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) 100px 160px 110px;
    align-items: center;
  }

  .head {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
  }

  .row {
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }

  .row:hover {
    background: #f7f9ff;
  }

  .name {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 9px;
  }

  .name strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  em {
    display: inline-flex;
    padding: 2px 7px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--tag) 14%, white);
    color: var(--tag);
    font-size: 11px;
    font-style: normal;
  }

  .workbook-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    padding-top: 12px;
  }

  .workbook-grid button {
    display: flex;
    min-height: 126px;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }
</style>
