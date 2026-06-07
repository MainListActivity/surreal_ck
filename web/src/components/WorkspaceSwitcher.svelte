<script lang="ts">
  import { onMount } from "svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
  import { getConnectionState } from "../lib/workspace-store.svelte";
  import { loadWorkspaces, switchWorkspace } from "../lib/switch-workspace.svelte";
  import { createCreateEntryController } from "../lib/create-entry";
  import type { WorkspaceListItem } from "../lib/switch-workspace";

  // 05a：创建入口收敛进切换器内部（Note 34/35）。oncreate 退化为可选「已创建」通知，
  // 不再承担「打开对话框」职责——无论谁挂 WorkspaceSwitcher，创建逻辑只有一份。
  let { oncreate }: { oncreate?: () => void } = $props();

  let workspaces = $state<WorkspaceListItem[]>([]);
  let currentDbName = $state<string | null>(null);
  let canCreate = $state(false);
  let open = $state(false);
  let dialogOpen = $state(false);
  let switching = $state<string | null>(null);
  let error = $state<string | null>(null);

  const createEntry = createCreateEntryController({
    canCreate: () => canCreate,
    reload: () => reload(),
    onCreated: () => oncreate?.(),
  });

  const connectionState = $derived(getConnectionState());

  const current = $derived(
    workspaces.find((ws) => ws.dbName === currentDbName) ?? null,
  );

  async function reload(): Promise<void> {
    const result = await loadWorkspaces();
    workspaces = result.workspaces;
    currentDbName = result.currentDbName;
    canCreate = result.canCreate;
  }

  async function choose(slug: string): Promise<void> {
    error = null;
    if (currentDbName && workspaces.find((ws) => ws.dbName === currentDbName)?.slug === slug) {
      open = false;
      return;
    }

    switching = slug;
    try {
      const result = await switchWorkspace(slug);
      if (result.ok) {
        open = false;
        await reload();
      } else if (result.reason === "forbidden") {
        error = "无权访问该工作区";
      } else if (result.reason === "refresh-failed") {
        error = "会话已过期，请重新登录";
      } else {
        error = result.message ?? "切换失败";
      }
    } finally {
      switching = null;
    }
  }

  function startCreate(): void {
    const next = createEntry.openDialog({ dropdownOpen: open, dialogOpen });
    open = next.dropdownOpen;
    dialogOpen = next.dialogOpen;
  }

  function cancelCreate(): void {
    const next = createEntry.closeDialog();
    open = next.dropdownOpen;
    dialogOpen = next.dialogOpen;
  }

  async function onCreated(): Promise<void> {
    // 创建对话框内部已完成 POST /api/workspaces → refresh → enterWorkspace → URL 落 /w/:slug；
    // 这里只负责关对话框 + reload 列表（新 workspace 出现并标记为当前）+ 通知外部。
    const next = await createEntry.handleCreated();
    open = next.dropdownOpen;
    dialogOpen = next.dialogOpen;
  }

  onMount(() => {
    void reload();
  });
</script>

<div class="switcher">
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button type="button" class="trigger" {...props}>
          <span class="label">{current?.name ?? "选择工作区"}</span>
          <span
            class="conn"
            data-state={connectionState}
            title={connectionState}
            aria-label={`连接状态：${connectionState}`}
          ></span>
          <span class="caret" aria-hidden="true">▾</span>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>

    <DropdownMenu.Content align="end" class="ws-menu">
      {#each workspaces as ws (ws.slug)}
        <DropdownMenu.Item
          class={`item ${ws.dbName === currentDbName ? "active" : ""}`}
          disabled={switching !== null}
          closeOnSelect={false}
          onSelect={() => choose(ws.slug)}
        >
          <span class="item-name">{ws.name}</span>
          <span class="item-role">{ws.role === "admin" ? "管理员" : "成员"}</span>
          {#if switching === ws.slug}<span class="item-spin">切换中…</span>{/if}
        </DropdownMenu.Item>
      {/each}

      {#if workspaces.length === 0}
        <div class="empty">暂无可用工作区</div>
      {/if}

      {#if createEntry.showEntry()}
        <DropdownMenu.Separator />
        <DropdownMenu.Item class="item create-item" closeOnSelect={false} onSelect={startCreate}>
          ＋ 新建工作区
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if dialogOpen}
    <CreateWorkspaceDialog onclose={cancelCreate} oncreated={() => void onCreated()} />
  {/if}
</div>

<style>
  .switcher {
    position: relative;
    display: inline-block;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid #c8d0dc;
    border-radius: 6px;
    background: #ffffff;
    color: #16181d;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 0.5rem 0.75rem;
  }

  .conn {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #98a2b3;
  }
  .conn[data-state="open"] {
    background: #16a34a;
  }
  .conn[data-state="closing"] {
    background: #d97706;
  }
  .conn[data-state="closed"] {
    background: #dc2626;
  }

  .caret {
    color: #546071;
    font-size: 0.7rem;
  }

  :global(.ws-menu) {
    min-width: 14rem;
  }

  :global(.ws-menu .item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    cursor: pointer;
    text-align: left;
    padding: 0.5rem 0.6rem;
  }
  :global(.ws-menu .item.active) {
    background: #eaf1ff;
    font-weight: 700;
  }

  .item-name {
    flex: 1;
  }
  .item-role {
    color: #546071;
    font-size: 0.75rem;
  }
  .item-spin {
    color: #1f6feb;
    font-size: 0.75rem;
  }

  .empty {
    color: #546071;
    padding: 0.5rem 0.6rem;
    font-size: 0.85rem;
  }

  :global(.ws-menu .create-item) {
    color: #1f6feb;
    font-weight: 650;
  }

  .error {
    position: absolute;
    right: 0;
    top: calc(100% + 0.35rem);
    margin: 0;
    color: #b42318;
    font-size: 0.8rem;
  }
</style>
