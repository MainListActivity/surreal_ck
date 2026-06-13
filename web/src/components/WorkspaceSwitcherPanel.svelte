<script lang="ts">
  import { onMount } from "svelte";
  import { AlertCircle, Check, LoaderCircle, Plus } from "@lucide/svelte";
  import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
  import { getConnectionState } from "../lib/workspace-store.svelte";
  import { loadWorkspaces, switchWorkspace } from "../lib/switch-workspace.svelte";
  import {
    createSwitchWorkspacePanelController,
    initialSwitchWorkspacePanelState,
  } from "../lib/switch-workspace-panel";

  let {
    open = $bindable(false),
    oncreate,
  }: {
    open?: boolean;
    oncreate?: () => void;
  } = $props();

  const controller = createSwitchWorkspacePanelController({
    loadWorkspaces,
    switchWorkspace,
    onCreated: () => oncreate?.(),
  });

  let panel = $state(initialSwitchWorkspacePanelState());

  const connectionState = $derived(getConnectionState());
  const current = $derived(
    panel.workspaces.find((ws) => ws.dbName === panel.currentDbName) ?? null,
  );

  $effect(() => {
    if (panel.open !== open) panel = { ...panel, open };
  });

  onMount(() => {
    void reload();
  });

  function publish(next: typeof panel): void {
    panel = next;
    open = next.open;
  }

  async function reload(): Promise<void> {
    try {
      publish(await controller.reload(panel));
    } catch (error) {
      publish({
        ...panel,
        error: error instanceof Error ? error.message : "工作区列表加载失败",
      });
    }
  }

  async function choose(slug: string): Promise<void> {
    if (panel.switching) return;
    publish({ ...panel, switching: slug, error: null });
    try {
      publish(await controller.choose(panel, slug));
    } catch (error) {
      publish({
        ...panel,
        switching: null,
        error: error instanceof Error ? error.message : "切换失败",
      });
    }
  }

  function startCreate(): void {
    publish(controller.startCreate(panel));
  }

  function cancelCreate(): void {
    publish(controller.cancelCreate(panel));
  }

  async function handleCreated(): Promise<void> {
    publish(await controller.handleCreated(panel));
  }

  function roleLabel(role: "admin" | "participant"): string {
    return role === "admin" ? "管理员" : "成员";
  }
</script>

<section class="workspace-switcher-panel" class:open={panel.open} aria-label="切换工作区">
  <div class="panel-inner">
    <div class="panel-status">
      <span
        class="conn"
        data-state={connectionState}
        title={connectionState}
        aria-label={`连接状态：${connectionState}`}
      ></span>
      <span>{current?.name ?? "选择工作区"}</span>
    </div>

    {#if panel.error}
      <p class="error" role="alert"><AlertCircle size={14} />{panel.error}</p>
    {/if}

    <div class="workspace-list">
      {#each panel.workspaces as ws (ws.slug)}
        {@const active = ws.dbName === panel.currentDbName}
        <button
          type="button"
          class="workspace-row"
          class:active
          aria-current={active ? "true" : undefined}
          disabled={panel.switching !== null}
          onclick={() => void choose(ws.slug)}
        >
          <span class="check-mark" aria-hidden="true">
            {#if active}<Check size={14} />{/if}
          </span>
          <span class="workspace-meta">
            <strong>{ws.name}</strong>
            <small>{roleLabel(ws.role)}</small>
          </span>
          {#if panel.switching === ws.slug}
            <span class="spin" aria-hidden="true"><LoaderCircle size={14} /></span>
          {/if}
        </button>
      {/each}

      {#if panel.workspaces.length === 0}
        <p class="empty">暂无可用工作区</p>
      {/if}
    </div>

    {#if panel.canCreate}
      <button type="button" class="create-row" onclick={startCreate}>
        <Plus size={14} />
        <span>新建工作区</span>
      </button>
    {/if}
  </div>
</section>

{#if panel.dialogOpen}
  <CreateWorkspaceDialog onclose={cancelCreate} oncreated={() => void handleCreated()} />
{/if}

<style>
  .workspace-switcher-panel {
    flex-shrink: 0;
    max-height: 0;
    overflow: hidden;
    border-top: 1px solid transparent;
    background: var(--surface);
    transition: max-height .18s ease, border-color .18s ease;
  }

  .workspace-switcher-panel.open {
    max-height: 260px;
    border-top-color: var(--border);
  }

  .panel-inner {
    padding: 8px 12px 10px;
  }

  .panel-status {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 2px 2px 7px;
    color: var(--text-3);
    font-size: 11px;
  }

  .conn {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
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

  .workspace-list {
    max-height: 176px;
    overflow-y: auto;
  }

  .workspace-row,
  .create-row {
    display: flex;
    width: 100%;
    align-items: center;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    text-align: left;
    cursor: pointer;
  }

  .workspace-row {
    gap: 7px;
    padding: 7px 8px;
  }

  .workspace-row:hover:not(:disabled),
  .create-row:hover {
    background: var(--bg);
  }

  .workspace-row.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .workspace-row:disabled {
    cursor: wait;
    opacity: .72;
  }

  .check-mark {
    display: grid;
    width: 16px;
    flex-shrink: 0;
    place-items: center;
    color: var(--primary);
  }

  .workspace-meta {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }

  .workspace-meta strong {
    overflow: hidden;
    color: inherit;
    font-size: 12px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-meta small {
    color: var(--text-3);
    font-size: 11px;
  }

  .create-row {
    gap: 7px;
    margin-top: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
    border-radius: 0;
    color: var(--primary);
    font-size: 12px;
    font-weight: 650;
  }

  .error,
  .empty {
    margin: 0;
    padding: 7px 8px;
    color: var(--text-3);
    font-size: 12px;
  }

  .error {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--error);
  }

  .spin {
    display: grid;
    place-items: center;
    animation: spin .85s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
