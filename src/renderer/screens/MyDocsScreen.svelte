<script lang="ts">
  import FileIcon from "../components/FileIcon.svelte";
  import Icon from "../components/Icon.svelte";
  import { folderDocs, folders, templateColors } from "../lib/mock";
  import type { Navigate } from "../lib/types";

  let { navigate }: { navigate: Navigate } = $props();

  let selected = $state("f1");
  let open = $state<Record<string, boolean>>({ f1: true });

  const docs = $derived(folderDocs[selected] ?? []);
</script>

<section class="docs">
  <aside class="folder-pane">
    <div class="pane-title">文件夹</div>
    {#each folders.filter((folder) => !folder.parent) as folder}
      <button class:selected={selected === folder.id} onclick={() => { selected = folder.id; if (folder.children.length) open = { ...open, [folder.id]: !open[folder.id] }; }}>
        <Icon name={open[folder.id] ? "folderOpen" : "folder"} size={15} />{folder.name}
      </button>
      {#if open[folder.id]}
        {#each folder.children as childId}
          {@const child = folders.find((folder) => folder.id === childId)}
          {#if child}
            <button class="child" class:selected={selected === child.id} onclick={() => (selected = child.id)}><Icon name="folder" size={15} />{child.name}</button>
          {/if}
        {/each}
      {/if}
    {/each}
    <div class="line"></div>
    <button class:selected={selected === "uncat"} onclick={() => (selected = "uncat")}><Icon name="file" size={15} />未分类文档</button>
    <button class="dashed"><Icon name="plus" size={13} />新建文件夹</button>
  </aside>

  <div class="main">
    <header>
      <h2>{selected === "uncat" ? "未分类文档" : folders.find((folder) => folder.id === selected)?.name}</h2>
      <button class="primary-btn" onclick={() => navigate("editor")}><Icon name="plus" size={13} color="#fff" />新建工作簿</button>
    </header>

    <div class="table">
      <div class="head"><span>名称</span><span>负责人</span><span>最近修改</span><span>模板类型</span></div>
      {#each docs as wb}
        <button class="row" onclick={() => navigate("editor")}>
          <span class="name"><FileIcon type={wb.fileType} size={22} /><strong>{wb.name}</strong></span>
          <span>{wb.modifier}</span>
          <span>{wb.modified}</span>
          <span><em style={`--tag:${templateColors[wb.template] ?? "var(--text-3)"}`}>{wb.template}</em></span>
        </button>
      {/each}
    </div>
  </div>
</section>

<style>
  .docs {
    display: flex;
    flex: 1;
    overflow: hidden;
    background: var(--bg);
  }

  .folder-pane {
    width: 220px;
    flex-shrink: 0;
    overflow: auto;
    padding: 16px 8px;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .pane-title {
    padding: 0 8px 10px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .6px;
  }

  .folder-pane button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }

  .folder-pane button:hover {
    background: var(--bg);
  }

  .folder-pane button.selected {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .child {
    padding-left: 28px !important;
  }

  .line {
    height: 1px;
    margin: 10px 0;
    background: var(--border);
  }

  .dashed {
    justify-content: center;
    margin-top: 12px;
    border: 1px dashed var(--border-dark) !important;
    color: var(--text-3) !important;
  }

  .main {
    flex: 1;
    overflow: auto;
    padding: 24px 28px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  h2 {
    margin: 0;
    color: var(--text-1);
    font-size: 16px;
  }

  header button {
    padding: 8px 14px;
  }

  .table {
    border-top: 1px solid var(--border);
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
    color: var(--text-1);
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
</style>
