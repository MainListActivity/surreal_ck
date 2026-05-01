<script lang="ts">
  import Avatar from "../../components/Avatar.svelte";
  import Icon from "../../components/Icon.svelte";
  import Logo from "../../components/Logo.svelte";
  import { appState } from "../../lib/app-state.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import type { Navigate } from "../../lib/types";
  import { editorUi } from "./lib/editor-ui.svelte";
  import { panelRegistry } from "./registries/panels";
  import { menuRegistry } from "./registries/menu";

  let { navigate }: { navigate: Navigate } = $props();

  let titleDraft = $state("");
  let titleFocused = $state(false);

  $effect(() => {
    if (!titleFocused) titleDraft = editorStore.workbookName;
  });

  // 占位：真实成员列表应来自 workspace store
  const quickMembers = ["王晓明", "李静"];

  async function saveTitle() {
    titleFocused = false;
    const next = titleDraft.trim();
    if (!next || next === editorStore.workbookName || appState.readOnly) {
      titleDraft = editorStore.workbookName;
      return;
    }
    const ok = await editorStore.renameWorkbook(next);
    if (!ok) titleDraft = editorStore.workbookName;
  }

  function handleTitleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      (event.currentTarget as HTMLInputElement).blur();
    } else if (event.key === "Escape") {
      titleDraft = editorStore.workbookName;
      (event.currentTarget as HTMLInputElement).blur();
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

  async function runMenuItem(item: (typeof menuRegistry)[number]) {
    editorUi.showMenu = false;
    await item.action();
  }
</script>

<header class="doc-topbar">
  <button class="icon-btn" onclick={() => navigate("home")}>
    <Icon name="chevronLeft" size={17} />
  </button>
  <button class="logo-btn" onclick={() => navigate("home")}>
    <Logo size="sm" />
  </button>
  <span class="divider"></span>
  <strong class="doc-title">
    {#if editorStore.loading}加载中…
    {:else if editorStore.error}加载失败
    {:else}
      <input
        value={titleDraft}
        readonly={appState.readOnly}
        aria-label="工作簿名称"
        oninput={(event) => (titleDraft = event.currentTarget.value)}
        onfocus={() => (titleFocused = true)}
        onblur={saveTitle}
        onkeydown={handleTitleKeydown}
      />
    {/if}
  </strong>
  <span
    class="sync"
    class:error={Boolean(editorStore.saveError)}
    class:warning={appState.readOnly}
  >
    {#if editorStore.saving}
      <Icon name="refresh" size={13} />保存中…
    {:else if editorStore.saveError}
      <Icon name="alertCircle" size={13} />保存失败
    {:else if appState.readOnly}
      <Icon name="wifiOff" size={13} />只读
    {:else}
      <Icon name="check" size={13} />已保存
    {/if}
  </span>
  {#if editorStore.pendingDraftCount > 0}
    <span class="draft-hint" title="这些草稿仅存在于内存中，待必填字段填齐后会自动保存">
      <Icon name="alertCircle" size={12} />
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
      <Icon name={tab.icon} size={15} />
    </button>
  {/each}
  <span class="divider"></span>
  <button class="share-btn" onclick={openShare}>
    <Icon name="share" size={13} color="#fff" />分享
  </button>
  <div class="member-stack">
    {#each quickMembers as member}
      <Avatar name={member} size={28} />
    {/each}
  </div>
  <div class="menu-wrap">
    <button class="icon-btn" onclick={toggleMenu} title="更多操作">
      <Icon name="moreH" size={16} />
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

  .doc-title input {
    height: 30px;
    width: min(520px, 100%);
    border: 1px solid transparent;
    background: transparent;
    padding: 4px 7px;
    font-weight: 650;
    border-radius: 6px;
    color: var(--text-1);
    font-size: 14px;
    outline: none;
  }

  .doc-title input:hover,
  .doc-title input:focus {
    border-color: var(--border);
    background: var(--bg);
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
