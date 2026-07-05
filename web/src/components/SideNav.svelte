<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import Logo from "./Logo.svelte";
  import WorkspaceSwitcherPanel from "./WorkspaceSwitcherPanel.svelte";
  import { Plus, House, Coins, Folder, Tag, Settings, Hash, Trash2, Search, Bell, BookOpen, Pin } from "@lucide/svelte";
  import { getCurrentUser, getCurrentWorkspace } from "../lib/workspace-store.svelte";
  import {
    canWriteSharedStructure as canWriteSharedStructureFn,
    isWorkspaceAdmin as isWorkspaceAdminFn,
  } from "../lib/permissions.svelte";
  import type { WorkspacePage } from "../lib/route";
  import type { WorkbookRow } from "../lib/workbooks";

  // HR-01/03 首页骨架侧栏：保留主导航 / 工具导航 / 新建文档入口，顶部搜索已接入；
  // workspace 切换从底部 inline panel 完成，避免再挂全局 dropdown。
  // legacy 的文件夹树 + 拖拽依赖已废弃的 folder 模型与后端 RPC，新模型下 workbook 表不带
  // folder（跨 workspace 靠 db 边界隔离），故「我的文档」退化为一个导航入口指向 docs 页，
  // 目录树留后续 issue。
  let {
    page,
    query = "",
    wsPanelOpen = $bindable(false),
    pinnedWorkbooks = [],
    allWorkbooks = [],
    onnavigate,
    onnewdoc,
    onsearchchange,
    onpinworkbook,
    onopenworkbook,
  }: {
    page: WorkspacePage;
    query?: string;
    wsPanelOpen?: boolean;
    pinnedWorkbooks?: WorkbookRow[];
    allWorkbooks?: WorkbookRow[];
    onnavigate?: (page: WorkspacePage) => void;
    onnewdoc?: () => void;
    onsearchchange?: (q: string) => void;
    onpinworkbook?: (id: string) => void;
    onopenworkbook?: (id: string) => void;
  } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  const canOpenAdminConsole = $derived(isWorkspaceAdminFn());
  const user = $derived(getCurrentUser());
  const workspace = $derived(getCurrentWorkspace());
  const userName = $derived(user?.displayName || user?.name || user?.email || "我");
  const workspaceName = $derived(workspace?.name || workspace?.slug || workspace?.dbName || "当前工作区");

  let pickerOpen = $state(false);

  const pinnedIds = $derived(new Set(pinnedWorkbooks.map((wb) => wb.id)));
  const unpinnedWorkbooks = $derived(allWorkbooks.filter((wb) => !pinnedIds.has(wb.id)));

  function go(target: WorkspacePage) {
    onnavigate?.(target);
  }

  function handleSearchInput(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    onsearchchange?.(value);
  }

  function toggleWorkspacePanel() {
    wsPanelOpen = !wsPanelOpen;
  }

  function handlePickerSelect(id: string) {
    onpinworkbook?.(id);
    pickerOpen = false;
  }
</script>

<aside class="side-nav">
  <div class="sidebar-top">
    <button class="brand" onclick={() => go("home")}><Logo /></button>
    <label class="sidebar-search" aria-label="搜索工作簿">
      <Search size={14} color="var(--text-3)" />
      <input type="search" value={query} oninput={handleSearchInput} placeholder="搜索工作簿..." />
    </label>
  </div>

  <div class="sidebar-nav">
    <button
      class="new-doc primary-btn"
      disabled={!canWriteSharedStructure}
      title={canWriteSharedStructure ? "新建文档" : "需要管理员权限"}
      onclick={() => onnewdoc?.()}
    >
      <Plus size={15} color="#fff" />新建文档
    </button>

    <span class="nav-label">导航</span>
    <nav class="main-nav">
      <button class:active={page === "home"} onclick={() => go("home")}>
        <House size={16} />首页
      </button>
      <button class:active={page === "dashboard"} onclick={() => go("dashboard")}>
        <Coins size={16} />仪表盘
      </button>
      <button class:active={page === "docs"} onclick={() => go("docs")}>
        <Folder size={16} />我的文档
      </button>
      <button class:active={page === "templates"} onclick={() => go("templates")}>
        <Tag size={16} />模板库
      </button>
    </nav>

    <div class="pinned-section">
      <div class="pinned-header">
        <span class="pinned-title">已固定</span>
        <button
          class="pin-add-btn"
          title="固定工作簿"
          aria-label="固定工作簿"
          onclick={() => (pickerOpen = !pickerOpen)}
        >
          <Plus size={13} />
        </button>
      </div>

      {#if pickerOpen && unpinnedWorkbooks.length > 0}
        <div class="pin-picker" role="listbox" aria-label="选择要固定的工作簿">
          {#each unpinnedWorkbooks as wb (wb.id)}
            <button
              class="pin-picker-item"
              role="option"
              aria-selected="false"
              onclick={() => handlePickerSelect(wb.id)}
            >
              <BookOpen size={13} />
              <span>{wb.name}</span>
            </button>
          {/each}
        </div>
      {:else if pickerOpen}
        <div class="pin-picker-empty">全部已固定</div>
      {/if}

      {#each pinnedWorkbooks as wb (wb.id)}
        <button class="pinned-item" onclick={() => onopenworkbook?.(wb.id)} title={wb.name}>
          <Pin size={13} color="var(--seed)" />
          <span class="pinned-name">{wb.name}</span>
        </button>
      {/each}
    </div>

    <span class="nav-label tool-label">工具</span>
    <div class="tool-nav">
      {#if canOpenAdminConsole}
        <button class:active={page === "admin"} onclick={() => go("admin")}>
          <Settings size={16} />工作区设置
        </button>
      {/if}
      <button
        class:active={page === "admin-console"}
        disabled={!canOpenAdminConsole}
        title={canOpenAdminConsole ? "SQL 控制台" : "需要管理员权限"}
        onclick={() => go("admin-console")}
      >
        <Hash size={16} />SQL 控制台
      </button>
      <button class:active={page === "trash"} onclick={() => go("trash")}>
        <Trash2 size={16} />回收站
      </button>
    </div>
  </div>

  <div class="sidebar-footer" aria-hidden="true"></div>

  <WorkspaceSwitcherPanel bind:open={wsPanelOpen} />

  <div class="sidebar-userbar" class:active={page === "settings"}>
    <div class="user-main">
      <Avatar name={userName} size={30} />
      <div>
        <button
          type="button"
          class="workspace-name"
          aria-expanded={wsPanelOpen}
          onclick={toggleWorkspacePanel}
        >
          {workspaceName}
        </button>
        <button type="button" class="user-name" title="打开个人设置" onclick={() => go("settings")}>
          {userName}
        </button>
      </div>
    </div>
    <button class="icon-btn notify-btn" title="通知功能待迁移" aria-label="通知功能待迁移">
      <Bell size={15} color="var(--text-3)" />
    </button>
  </div>
</aside>

<style>
  .side-nav {
    display: flex;
    width: 256px;
    height: 100%;
    flex-shrink: 0;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .sidebar-top,
  .sidebar-footer,
  .sidebar-userbar {
    flex-shrink: 0;
  }

  .sidebar-top {
    padding: 16px 16px 14px;
  }

  .brand {
    display: flex;
    width: 100%;
    margin-bottom: 14px;
    padding: 2px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    cursor: pointer;
  }

  .sidebar-search {
    display: flex;
    width: 100%;
    height: 38px;
    align-items: center;
    gap: 9px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: var(--bg);
  }

  .sidebar-search:focus-within {
    border-color: var(--primary);
    background: var(--surface);
  }

  .sidebar-search input {
    width: 100%;
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-1);
    font-size: 13px;
  }

  .new-doc {
    width: calc(100% - 32px);
    height: 42px;
    margin: 0 16px 18px;
    border-radius: 12px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 8px 18px -8px rgba(47, 122, 76, .6);
    transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
  }

  .new-doc:hover:not(:disabled) {
    background: var(--brand-strong);
    transform: translateY(-1px);
    box-shadow: 0 12px 22px -8px rgba(47, 122, 76, .7);
  }

  .new-doc:disabled {
    opacity: .55;
    cursor: not-allowed;
    box-shadow: none;
  }

  .sidebar-nav {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    overflow-y: auto;
    padding: 0 0 8px;
  }

  .nav-label {
    padding: 0 22px 8px;
    color: var(--text-3);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  .tool-label {
    padding-top: 18px;
  }

  .main-nav,
  .tool-nav {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .main-nav button,
  .tool-nav button {
    display: flex;
    align-items: center;
    gap: 11px;
    width: calc(100% - 32px);
    margin: 0 16px;
    padding: 9px 12px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background .15s ease, color .15s ease;
  }

  .main-nav button:hover,
  .tool-nav button:hover:not(:disabled) {
    background: var(--bg);
    color: var(--text-1);
  }

  .tool-nav button:disabled {
    cursor: not-allowed;
    opacity: .52;
  }

  button.active {
    background: var(--primary-light);
    color: var(--brand-strong);
    font-weight: 600;
  }

  .tool-nav {
    margin-top: auto;
  }

  .sidebar-footer {
    flex-shrink: 0;
    padding: 0 12px 8px;
  }

  .sidebar-userbar {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

  .sidebar-userbar.active {
    background: var(--primary-light);
  }

  .user-main {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 9px;
    padding: 2px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    text-align: left;
  }

  .user-main div {
    min-width: 0;
    flex: 1;
  }

  .workspace-name,
  .user-name {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    overflow: hidden;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .workspace-name {
    color: var(--text-1);
    font-size: 12px;
    font-weight: 650;
  }

  .workspace-name:hover,
  .user-name:hover {
    color: var(--primary);
  }

  .user-name {
    color: var(--text-3);
    font-size: 11px;
  }

  .notify-btn {
    flex-shrink: 0;
  }

  .pinned-section {
    display: flex;
    flex-direction: column;
    margin-top: 22px;
    padding: 0;
  }

  .pinned-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 22px 8px;
  }

  .pinned-title {
    color: var(--text-3);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  .pin-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }

  .pin-add-btn:hover {
    background: var(--bg);
    color: var(--text-1);
  }

  .pinned-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: calc(100% - 28px);
    margin: 0 14px;
    padding: 7px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--text-2);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition: background .15s ease;
  }

  .pinned-item:hover {
    background: var(--bg);
  }

  .pinned-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pin-picker {
    display: flex;
    flex-direction: column;
    margin: 0 14px 4px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    overflow: hidden;
  }

  .pin-picker-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .pin-picker-item:last-child {
    border-bottom: 0;
  }

  .pin-picker-item:hover {
    background: var(--bg);
  }

  .pin-picker-empty {
    padding: 8px 10px;
    color: var(--text-3);
    font-size: 12px;
    margin: 0 14px 4px;
  }
</style>
