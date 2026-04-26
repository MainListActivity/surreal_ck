<script lang="ts">
  import FileIcon from "../components/FileIcon.svelte";
  import Icon from "../components/Icon.svelte";
  import { appState } from "../lib/app-state.svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import type { Navigate } from "../lib/types";

  let { navigate }: { navigate: Navigate } = $props();

  let selectedFolderId = $state<string | null>(null);
  let open = $state<Record<string, boolean>>({});

  $effect(() => {
    const ws = appState.workspace;
    if (ws) void workbooksStore.loadForWorkspace(ws.id);
  });

  const rootFolders = $derived(workbooksStore.folders.filter((f) => !f.parentId));
  const docs = $derived(workbooksStore.filterByFolder(selectedFolderId));

  function selectedFolderName(): string {
    if (!selectedFolderId) return "未分类文档";
    return workbooksStore.folders.find((f) => f.id === selectedFolderId)?.name ?? "未分类文档";
  }

  function childFolders(parentId: string) {
    return workbooksStore.folders.filter((f) => f.parentId === parentId);
  }

  async function handleCreateBlank() {
    const ws = appState.workspace;
    if (!ws || appState.readOnly) return;
    const wb = await workbooksStore.createBlank(ws.id, "未命名工作簿", selectedFolderId);
    if (wb) navigate("editor", { workbookId: wb.id });
  }

  function formatDate(iso?: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("zh-CN");
  }
</script>

<section class="docs">
  <aside class="folder-pane">
    <div class="pane-title">文件夹</div>
    {#each rootFolders as folder}
      {@const children = childFolders(folder.id)}
      <button class:selected={selectedFolderId === folder.id} onclick={() => { selectedFolderId = folder.id; if (children.length) open = { ...open, [folder.id]: !open[folder.id] }; }}>
        <Icon name={open[folder.id] ? "folderOpen" : "folder"} size={15} />{folder.name}
      </button>
      {#if open[folder.id]}
        {#each children as child}
          <button class="child" class:selected={selectedFolderId === child.id} onclick={() => (selectedFolderId = child.id)}>
            <Icon name="folder" size={15} />{child.name}
          </button>
        {/each}
      {/if}
    {/each}
    <div class="line"></div>
    <button class:selected={selectedFolderId === null} onclick={() => (selectedFolderId = null)}>
      <Icon name="file" size={15} />未分类文档
    </button>
  </aside>

  <div class="main">
    <header>
      <h2>{selectedFolderName()}</h2>
      <button class="primary-btn" onclick={handleCreateBlank} disabled={appState.readOnly}>
        <Icon name="plus" size={13} color="#fff" />新建工作簿
      </button>
    </header>

    {#if workbooksStore.loading}
      <div class="state-msg">加载中…</div>
    {:else if workbooksStore.error}
      <div class="state-msg error">{workbooksStore.error}</div>
    {:else if docs.length === 0}
      <div class="state-msg">此目录下暂无工作簿</div>
    {:else}
      <div class="table">
        <div class="head"><span>名称</span><span>模板类型</span><span>最近修改</span></div>
        {#each docs as wb}
          <button class="row" onclick={() => navigate("editor", { workbookId: wb.id })}>
            <span class="name"><FileIcon type="excel" size={22} /><strong>{wb.name}</strong></span>
            <span><em>{wb.templateKey ?? "自定义"}</em></span>
            <span>{formatDate(wb.updatedAt)}</span>
          </button>
        {/each}
      </div>
    {/if}
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

  header button:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .table {
    border-top: 1px solid var(--border);
  }

  .head,
  .row {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) 120px 160px;
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
    background: var(--primary-light);
    color: var(--primary);
    font-size: 11px;
    font-style: normal;
  }

  .state-msg {
    padding: 48px 0;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
  }

  .state-msg.error {
    color: var(--error);
  }
</style>
