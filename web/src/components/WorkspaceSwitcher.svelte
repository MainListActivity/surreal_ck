<script lang="ts">
  import { onMount } from "svelte";
  import { getConnectionState } from "../lib/workspace-store.svelte";
  import { loadWorkspaces, switchWorkspace } from "../lib/switch-workspace.svelte";
  import type { WorkspaceListItem } from "../lib/switch-workspace";

  /** 点击「新建 workspace」时触发 issue 06 流程；由父组件提供。 */
  let { oncreate }: { oncreate?: () => void } = $props();

  let workspaces = $state<WorkspaceListItem[]>([]);
  let currentDbName = $state<string | null>(null);
  let canCreate = $state(false);
  let open = $state(false);
  let switching = $state<string | null>(null);
  let error = $state<string | null>(null);

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
    open = false;
    oncreate?.();
  }

  onMount(() => {
    void reload();
  });
</script>

<div class="switcher">
  <button
    type="button"
    class="trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span class="label">{current?.name ?? "选择工作区"}</span>
    <span
      class="conn"
      data-state={connectionState}
      title={connectionState}
      aria-label={`连接状态：${connectionState}`}
    ></span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <ul class="menu" role="listbox">
      {#each workspaces as ws (ws.slug)}
        <li role="option" aria-selected={ws.dbName === currentDbName}>
          <button
            type="button"
            class="item"
            class:active={ws.dbName === currentDbName}
            disabled={switching !== null}
            onclick={() => choose(ws.slug)}
          >
            <span class="item-name">{ws.name}</span>
            <span class="item-role">{ws.role === "admin" ? "管理员" : "成员"}</span>
            {#if switching === ws.slug}<span class="item-spin">切换中…</span>{/if}
          </button>
        </li>
      {/each}

      {#if workspaces.length === 0}
        <li class="empty">暂无可用工作区</li>
      {/if}

      {#if canCreate}
        <li class="create">
          <button type="button" class="item create-item" onclick={startCreate}>
            ＋ 新建工作区
          </button>
        </li>
      {/if}
    </ul>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
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

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 0.35rem);
    z-index: 20;
    min-width: 14rem;
    margin: 0;
    padding: 0.35rem;
    list-style: none;
    border: 1px solid #d9dee7;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
  }

  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #16181d;
    cursor: pointer;
    font: inherit;
    text-align: left;
    padding: 0.5rem 0.6rem;
  }
  .item:hover:not(:disabled) {
    background: #f1f4f9;
  }
  .item:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .item.active {
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

  .create {
    margin-top: 0.25rem;
    border-top: 1px solid #e5e9f0;
    padding-top: 0.25rem;
  }
  .create-item {
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
