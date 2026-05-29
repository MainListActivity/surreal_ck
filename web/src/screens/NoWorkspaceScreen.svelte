<script lang="ts">
  import CreateWorkspaceDialog from "../components/CreateWorkspaceDialog.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { logout } from "../lib/auth";

  // 账号当前没有任何可用 workspace 的空状态屏。
  // 不把用户困在「无工作区」错误里——有创建权限就在这里直接走 D2-06 的创建对话框
  // （与 WorkspaceSwitcher 用的是同一个 CreateWorkspaceDialog，创建逻辑全仓一份）；
  // 无创建权限则提示联系管理员邀请。创建成功后 CreateWorkspaceDialog 内部已完成
  // POST /api/workspaces → refresh → enterWorkspace → URL 落 /w/:slug，onCreated 通知
  // App 重新 ensureWorkspace 进入新工作区。
  let {
    canCreate,
    oncreated,
  }: {
    canCreate: boolean;
    oncreated?: () => void;
  } = $props();

  let dialogOpen = $state(false);
</script>

<main class="no-workspace">
  {#if canCreate}
    <EmptyState
      icon="plus"
      title="还没有工作区"
      desc="创建你的第一个工作区即可开始。每个工作区是一个独立的数据库，成员与数据互不干扰。"
      action="新建工作区"
      onAction={() => (dialogOpen = true)}
    />
  {:else}
    <EmptyState
      icon="info"
      title="暂无可用工作区"
      desc="你的账号还没有被加入任何工作区。请联系工作区管理员邀请你加入。"
      action="重新登录"
      onAction={() => void logout()}
    />
  {/if}

  {#if dialogOpen}
    <CreateWorkspaceDialog
      onclose={() => (dialogOpen = false)}
      oncreated={() => {
        dialogOpen = false;
        oncreated?.();
      }}
    />
  {/if}
</main>

<style>
  .no-workspace {
    display: flex;
    min-height: 100vh;
    background: var(--bg);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
</style>
