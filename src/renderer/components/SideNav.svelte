<script lang="ts">
  import type { Navigate, ScreenId } from "../lib/types";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";
  import Logo from "./Logo.svelte";
  import { logout } from "../lib/auth.actions";
  import { appState } from "../lib/app-state.svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import type { FolderDTO } from "../../shared/rpc.types";

  let { current, navigate }: { current: ScreenId; navigate: Navigate } = $props();

  let docsOpen = $state(true);
  let workspaceIndex = $state(0);
  const workspaces = ["华润置地破产重整", "蓝鼎国际清算"];

  /** 展开的文件夹 id 集合 */
  let expandedFolders = $state<Record<string, boolean>>({});
  /** 当前正在新建子目录的父节点 id；null 表示在根节点（“我的文档”）下新建 */
  let creatingUnder = $state<string | null | undefined>(undefined);
  let newFolderName = $state("");
  let creating = $state(false);

  $effect(() => {
    const ws = appState.workspace;
    if (ws) void workbooksStore.loadForWorkspace(ws.id);
  });

  const rootFolders = $derived(
    workbooksStore.folders
      .filter((f) => !f.parentId)
      .slice()
      .sort((a, b) => a.position - b.position)
  );

  function childrenOf(parentId: string): FolderDTO[] {
    return workbooksStore.folders
      .filter((f) => f.parentId === parentId)
      .slice()
      .sort((a, b) => a.position - b.position);
  }

  function toggleFolder(id: string) {
    expandedFolders = { ...expandedFolders, [id]: !expandedFolders[id] };
  }

  function startCreate(parentId: string | null, event: MouseEvent) {
    event.stopPropagation();
    creatingUnder = parentId;
    newFolderName = "";
    if (parentId) {
      expandedFolders = { ...expandedFolders, [parentId]: true };
    } else {
      docsOpen = true;
    }
  }

  function cancelCreate() {
    creatingUnder = undefined;
    newFolderName = "";
  }

  async function submitCreate() {
    const ws = appState.workspace;
    const name = newFolderName.trim();
    if (!ws || !name || creating) return;
    creating = true;
    const parentId = creatingUnder ?? undefined;
    const folder = await workbooksStore.createFolder(ws.id, name, parentId);
    creating = false;
    if (folder) {
      cancelCreate();
      if (parentId) expandedFolders = { ...expandedFolders, [parentId]: true };
    }
  }

  function onInputKey(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCreate();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelCreate();
    }
  }

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }
</script>

<aside class="side-nav">
  <button class="brand" onclick={() => navigate("home")}><Logo /></button>

  <button class="workspace" onclick={() => (workspaceIndex = workspaceIndex === 0 ? 1 : 0)}>
    <span>{workspaces[workspaceIndex]}</span>
    <Icon name="chevronDown" size={13} color="var(--text-3)" />
  </button>

  <button class="new-doc primary-btn" onclick={() => navigate("home")}>
    <Icon name="plus" size={15} color="#fff" />新建文档
  </button>

  {#snippet folderNode(folder: FolderDTO, depth: number)}
    {@const kids = childrenOf(folder.id)}
    {@const expanded = !!expandedFolders[folder.id]}
    <div class="tree-item">
      <div class="tree-row" style="padding-left: {depth * 14 + 8}px">
        <button
          type="button"
          class="row-main"
          onclick={() => { toggleFolder(folder.id); navigate("mydocs", { folderId: folder.id }); }}
        >
          <span class="caret" class:invisible={kids.length === 0}>
            <Icon name={expanded ? "chevronDown" : "chevronRight"} size={11} />
          </span>
          <Icon name={expanded ? "folderOpen" : "folder"} size={14} />
          <span class="label">{folder.name}</span>
        </button>
        <button
          type="button"
          class="add-sub"
          title="新建子目录"
          onclick={(e) => startCreate(folder.id, e)}
        >
          <Icon name="plus" size={11} />
        </button>
      </div>
      {#if expanded}
        {#each kids as child (child.id)}
          {@render folderNode(child, depth + 1)}
        {/each}
        {#if creatingUnder === folder.id}
          <div class="new-input-row" style="padding-left: {(depth + 1) * 14 + 22}px">
            <Icon name="folder" size={13} />
            <input
              use:focusOnMount
              placeholder="子目录名称"
              bind:value={newFolderName}
              onkeydown={onInputKey}
              onblur={() => { if (!newFolderName.trim()) cancelCreate(); }}
              disabled={creating}
            />
          </div>
        {/if}
      {/if}
    </div>
  {/snippet}

  <nav>
    <button class:active={current === "home"} onclick={() => navigate("home")}>
      <Icon name="home" size={16} />首页
    </button>

    <div class="docs-root">
      <div class="docs-root-row" class:active={current === "mydocs"}>
        <button
          type="button"
          class="docs-root-btn"
          onclick={() => { docsOpen = !docsOpen; navigate("mydocs"); }}
        >
          <Icon name={docsOpen ? "folderOpen" : "folder"} size={16} />
          <span class="label">我的文档</span>
        </button>
        <button
          type="button"
          class="add-sub root-add"
          title="新建目录"
          onclick={(e) => startCreate(null, e)}
        >
          <Icon name="plus" size={12} />
        </button>
        <button
          type="button"
          class="chevron-btn"
          onclick={() => (docsOpen = !docsOpen)}
          aria-label={docsOpen ? "折叠" : "展开"}
        >
          <span class:rotated={!docsOpen} class="chevron"><Icon name="chevronDown" size={13} /></span>
        </button>
      </div>

      {#if docsOpen}
        <div class="doc-tree">
          {#if workbooksStore.loading && rootFolders.length === 0}
            <div class="hint">加载中…</div>
          {:else if rootFolders.length === 0 && creatingUnder !== null}
            <div class="hint">暂无目录</div>
          {/if}

          {#each rootFolders as folder (folder.id)}
            {@render folderNode(folder, 0)}
          {/each}

          {#if creatingUnder === null}
            <div class="new-input-row" style="padding-left: 22px">
              <Icon name="folder" size={13} />
              <input
                use:focusOnMount
                placeholder="目录名称"
                bind:value={newFolderName}
                onkeydown={onInputKey}
                onblur={() => { if (!newFolderName.trim()) cancelCreate(); }}
                disabled={creating}
              />
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </nav>

  <div class="bottom-nav">
    <button class:active={current === "admin"} onclick={() => navigate("admin")}><Icon name="settings" size={16} />工作区设置</button>
    <button><Icon name="trash" size={16} />回收站</button>
  </div>

  <div class="user">
    <Avatar name="我" size={30} />
    <div><strong>已登录</strong><span>组织账号</span></div>
    <button class="icon-btn logout-btn" title="退出登录" onclick={logout}>
      <Icon name="logout" size={15} color="var(--text-3)" />
    </button>
  </div>
</aside>

<style>
  .side-nav {
    display: flex;
    width: 200px;
    height: 100%;
    flex-shrink: 0;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .brand {
    display: flex;
    padding: 16px 16px 12px;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    width: 100%;
  }

  .brand:hover {
    background: var(--bg);
  }

  .workspace,
  nav button,
  .bottom-nav button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: calc(100% - 24px);
    margin: 0 12px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }

  .workspace {
    justify-content: space-between;
    margin-top: 10px;
    padding: 7px 10px;
    background: var(--bg);
    font-size: 12px;
    font-weight: 550;
  }

  .workspace span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-doc {
    width: calc(100% - 24px);
    margin: 8px 12px;
    padding: 8px 0;
  }

  nav {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }

  nav button,
  .bottom-nav button {
    padding: 7px 10px;
  }

  nav button:hover,
  .bottom-nav button:hover {
    background: var(--bg);
  }

  button.active {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  nav button > span:first-of-type {
    flex: 1;
  }

  .chevron {
    margin-left: auto;
    transition: transform .15s ease;
  }

  .chevron.rotated {
    transform: rotate(-90deg);
  }

  .docs-root {
    display: flex;
    flex-direction: column;
  }

  .docs-root-row {
    display: flex;
    width: calc(100% - 24px);
    margin: 0 12px;
    align-items: center;
    border-radius: 7px;
  }

  .docs-root-row:hover {
    background: var(--bg);
  }

  .docs-root-row.active {
    background: var(--primary-light);
  }

  .docs-root-row.active .docs-root-btn,
  .docs-root-row.active .label {
    color: var(--primary);
    font-weight: 650;
  }

  .docs-root-btn {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    margin: 0 !important;
    width: auto !important;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
    overflow: hidden;
  }

  .docs-root-btn .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron-btn {
    display: inline-flex;
    width: 22px;
    height: 22px;
    margin: 0 4px 0 0 !important;
    padding: 0 !important;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-3);
  }

  .chevron-btn:hover {
    background: var(--border);
  }

  .doc-tree {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 8px 6px 8px;
  }

  .tree-item {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .tree-row {
    display: flex;
    width: 100%;
    align-items: center;
    border-radius: 6px;
  }

  .tree-row:hover {
    background: var(--bg);
  }

  .row-main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 6px;
    padding: 5px 7px;
    margin: 0 !important;
    width: auto !important;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    text-align: left;
    overflow: hidden;
  }

  .row-main > .caret {
    display: inline-flex;
    width: 12px;
    flex: 0 0 12px;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    flex-shrink: 0;
  }

  .row-main > .caret.invisible {
    visibility: hidden;
  }

  .row-main .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .add-sub {
    display: inline-flex;
    width: 22px;
    height: 22px;
    margin: 0 4px 0 0 !important;
    padding: 0 !important;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-3);
    opacity: 0;
    transition: opacity .12s ease, background .12s ease, color .12s ease;
    flex-shrink: 0;
  }

  .tree-row:hover .add-sub,
  .docs-root-row:hover .add-sub {
    opacity: 1;
  }

  .add-sub:hover {
    background: var(--primary-light);
    color: var(--primary);
  }

  .root-add {
    margin-left: 0;
  }

  .new-input-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 7px;
  }

  .new-input-row input {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    border: 1px solid var(--primary);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    outline: none;
  }

  .hint {
    padding: 4px 10px;
    color: var(--text-3);
    font-size: 11px;
  }

  .bottom-nav {
    padding: 4px 0;
  }

  .user {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
  }

  .user div {
    min-width: 0;
    flex: 1;
  }

  .user strong,
  .user span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user strong {
    color: var(--text-1);
    font-size: 12px;
  }

  .user span {
    color: var(--text-3);
    font-size: 11px;
  }
</style>
