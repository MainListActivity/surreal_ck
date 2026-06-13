<script lang="ts">
  import { tick } from "svelte";
  import Avatar from "../../components/Avatar.svelte";
  import Logo from "../../components/Logo.svelte";
  import { ChevronLeft, RefreshCw, AlertCircle, WifiOff, Check, Share, Ellipsis, Pencil, X } from "@lucide/svelte";
  import { canWriteSharedStructure as canWriteSharedStructureFn } from "../../lib/permissions.svelte";
  import { editorStore } from "../../lib/editor-store.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";
  import { panelRegistry } from "./registries/panels";
  import { menuRegistry } from "./registries/menu";

  let { workbookName = "", onback }: { workbookName?: string; onback?: () => void } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  const titleValue = $derived(editorStore.workbook?.name ?? workbookName);

  let editingTitle = $state(false);
  let titleDraft = $state("");
  let committingTitle = $state(false);
  let titleInputEl = $state<HTMLInputElement | null>(null);

  async function startRenameTitle(event?: MouseEvent) {
    event?.stopPropagation();
    if (!canWriteSharedStructure || editorStore.loading || Boolean(editorStore.error)) return;
    titleDraft = titleValue || "未命名工作簿";
    editingTitle = true;
    await tick();
    titleInputEl?.focus();
    titleInputEl?.select();
  }

  function cancelRenameTitle() {
    editingTitle = false;
    titleDraft = "";
  }

  async function commitRenameTitle() {
    if (!editingTitle || committingTitle) return;
    const next = titleDraft.trim();
    if (next && next === titleValue) {
      cancelRenameTitle();
      return;
    }
    committingTitle = true;
    const ok = await editorStore.renameWorkbook(next);
    committingTitle = false;
    if (ok) cancelRenameTitle();
  }

  function handleTitleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRenameTitle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRenameTitle();
    }
  }

  function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    editorUi.showMenu = !editorUi.showMenu;
  }

  function openShare(event?: MouseEvent) {
    event?.stopPropagation();
    editorUi.showShare = true;
  }

  // 占位：真实成员列表应来自 workspace store
  const quickMembers = ["王晓明", "李静"];

  async function runMenuItem(item: (typeof menuRegistry)[number]) {
    editorUi.showMenu = false;
    await item.action();
  }
</script>

<header class="doc-topbar">
  <button class="icon-btn" onclick={() => onback?.()}>
    <ChevronLeft size={17} />
  </button>
  <button class="logo-btn" onclick={() => onback?.()}>
    <Logo size="sm" />
  </button>
  <span class="divider"></span>
  <strong class="doc-title">
    {#if editorStore.loading}加载中…
    {:else if editorStore.error}加载失败
    {:else if editingTitle}
      <input
        bind:this={titleInputEl}
        class="title-input"
        bind:value={titleDraft}
        disabled={committingTitle}
        aria-label="工作簿名"
        onblur={() => void commitRenameTitle()}
        onkeydown={handleTitleKeydown}
      />
      <button
        type="button"
        class="icon-btn title-action"
        title="取消重命名"
        aria-label="取消重命名"
        disabled={committingTitle}
        onmousedown={(event) => event.preventDefault()}
        onclick={cancelRenameTitle}
      >
        <X size={13} />
      </button>
    {:else}
      <button
        type="button"
        class="title-button"
        title={canWriteSharedStructure ? "双击重命名工作簿" : (titleValue || "未命名工作簿")}
        disabled={!canWriteSharedStructure}
        ondblclick={(event) => void startRenameTitle(event)}
      >
        <span class="title-text">{titleValue || "未命名工作簿"}</span>
      </button>
      {#if canWriteSharedStructure}
        <button
          type="button"
          class="icon-btn title-action"
          title="重命名工作簿"
          aria-label="重命名工作簿"
          onclick={(event) => void startRenameTitle(event)}
        >
          <Pencil size={13} />
        </button>
      {/if}
    {/if}
  </strong>
  <span
    class="sync"
    class:error={Boolean(editorStore.saveError)}
    class:warning={!canWriteSharedStructure}
  >
    {#if editorStore.saving}
      <RefreshCw size={13} />保存中…
    {:else if editorStore.saveError}
      <AlertCircle size={13} />保存失败
    {:else if !canWriteSharedStructure}
      <WifiOff size={13} />只读
    {:else}
      <Check size={13} />已保存
    {/if}
  </span>
  {#if editorStore.pendingDraftCount > 0}
    <span class="draft-hint" title="这些草稿仅存在于内存中，待必填字段填齐后会自动保存">
      <AlertCircle size={12} />
      {editorStore.pendingDraftCount} 条未保存草稿
    </span>
  {/if}
  <span class="divider"></span>
  {#each panelRegistry as tab}
    <button
      class="icon-btn panel-toggle"
      class:active={editorUi.panelOpen && editorUi.panelTab === tab.id}
      title={tab.label}
      onclick={() => editorUi.togglePanel(tab.id)}
    >
      <svelte:component this={tab.icon} size={15} />
    </button>
  {/each}
  <span class="divider"></span>
  <button class="share-btn" onclick={openShare}>
    <Share size={13} color="#fff" />分享
  </button>
  <div class="member-stack">
    {#each quickMembers as member}
      <Avatar name={member} size={28} />
    {/each}
  </div>
  <div class="menu-wrap">
    <button class="icon-btn" onclick={toggleMenu} title="更多操作">
      <Ellipsis size={16} />
    </button>
    {#if editorUi.showMenu}
      <div class="menu-pop">
        {#each menuRegistry as item}
          <button class:danger={item.danger} onclick={() => runMenuItem(item)}>
            {item.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</header>

<style>
  .doc-topbar {
    display: flex;
    height: 48px;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .logo-btn {
    display: flex;
    align-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 4px 6px;
    cursor: pointer;
  }

  .logo-btn:hover {
    background: var(--bg);
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border);
  }

  .doc-title {
    display: flex;
    align-items: center;
    min-width: 160px;
    flex: 1;
    overflow: hidden;
    color: var(--text-1);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title-button {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .title-button:hover:not(:disabled) {
    background: var(--bg);
  }

  .title-button:disabled {
    cursor: default;
  }

  .title-text {
    overflow: hidden;
    padding: 4px 7px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title-input {
    width: min(420px, 100%);
    height: 30px;
    min-width: 120px;
    border: 1px solid var(--primary);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 14px;
    font-weight: 650;
    padding: 0 8px;
    outline: 0;
  }

  .title-action {
    flex: 0 0 auto;
  }

  .sync {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--success);
    font-size: 12px;
  }

  .sync.warning {
    color: var(--warning);
  }

  .sync.error {
    color: var(--error);
  }

  .draft-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border-radius: 11px;
    background: var(--warning-bg);
    color: var(--warning);
    font-size: 11px;
    font-weight: 600;
  }

  .panel-toggle.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .share-btn {
    display: inline-flex;
    height: 30px;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    border: 0;
    border-radius: 7px;
    background: var(--primary);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .member-stack {
    display: flex;
    margin-left: 2px;
  }

  .member-stack :global(.avatar) {
    margin-left: -6px;
    border: 2px solid #fff;
  }

  .menu-wrap {
    position: relative;
  }

  .menu-pop {
    position: absolute;
    top: 36px;
    right: 0;
    z-index: 30;
    min-width: 156px;
    padding: 4px 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
  }

  .menu-pop button {
    width: 100%;
    padding: 8px 16px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }

  .menu-pop button:hover {
    background: var(--bg);
  }

  .menu-pop button.danger {
    color: var(--error);
  }
</style>
