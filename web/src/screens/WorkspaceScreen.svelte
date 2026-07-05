<script lang="ts">
  import SideNav from "../components/SideNav.svelte";
  import ActivityPanel from "../components/ActivityPanel.svelte";
  import DashboardScreen from "../features/dashboard/WorkbookDashboardScreen.svelte";
  import { dashboardStore } from "../features/dashboard/lib/dashboard-store.svelte";
  import AdminConsoleScreen from "./AdminConsoleScreen.svelte";
  import HomeScreen from "./HomeScreen.svelte";
  import TemplatesScreen from "./TemplatesScreen.svelte";
  import PlaceholderScreen from "./PlaceholderScreen.svelte";
  import ProfileScreen from "./ProfileScreen.svelte";
  import WorkspaceSettingsScreen from "./WorkspaceSettingsScreen.svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import {
    canWriteSharedStructure as canWriteSharedStructureFn,
    isWorkspaceAdmin as isWorkspaceAdminFn,
  } from "../lib/permissions.svelte";
  import type { WorkspacePage } from "../lib/route";
  import { Lock, Trash2 } from "@lucide/svelte";
  import { getCurrentWorkspace } from "../lib/workspace-store.svelte";
  import { pinWorkbook, readPinnedWorkbooks } from "../lib/workbook-home";
  import type { WorkbookRow } from "../lib/workbooks";

  // workspace 首页 shell：左侧 SideNav + 右侧按 page 切换内容。
  // 已迁功能（首页 workbook 列表）直接可用；未迁页面（模板/仪表盘/个人设置/
  // 回收站）给明确占位，入口不丢——这是 D2-09 删除 web/legacy/ 前的安全阀。
  let {
    slug,
    page,
    onopenworkbook,
    onopenaichat,
    onnavigate,
  }: {
    slug: string;
    page: WorkspacePage;
    onopenworkbook?: (workbookId: string) => void;
    onopenaichat?: () => void;
    onnavigate?: (page: WorkspacePage) => void;
  } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  const canOpenAdminConsole = $derived(isWorkspaceAdminFn());
  let query = $state("");
  let wsPanelOpen = $state(false);

  const currentWorkspace = $derived(getCurrentWorkspace());
  const dbName = $derived(currentWorkspace?.dbName ?? "");

  let pinnedIds = $state<string[]>([]);

  $effect(() => {
    if (dbName) {
      pinnedIds = readPinnedWorkbooks(localStorage, dbName);
    }
  });

  const pinnedWorkbooks = $derived<WorkbookRow[]>(
    pinnedIds
      .map((id) => workbooksStore.workbooks.find((wb) => wb.id === id))
      .filter((wb): wb is WorkbookRow => wb !== undefined),
  );

  function handlePinWorkbook(id: string) {
    if (!dbName) return;
    pinnedIds = pinWorkbook(localStorage, dbName, id);
  }

  $effect(() => {
    if (page === "dashboard") {
      void dashboardStore.open({});
    }
  });

  function goHome() {
    onnavigate?.("home");
  }

  async function createBlankAndOpen() {
    if (!canWriteSharedStructure) {
      onnavigate?.("home");
      return;
    }
    const wb = await workbooksStore.createBlank("未命名工作簿");
    if (wb) onopenworkbook?.(wb.id);
    else onnavigate?.("home");
  }
</script>

<div class="workspace-shell">
  <SideNav
    {page}
    {query}
    bind:wsPanelOpen
    {pinnedWorkbooks}
    allWorkbooks={workbooksStore.workbooks}
    onnavigate={(target) => onnavigate?.(target)}
    onnewdoc={() => void createBlankAndOpen()}
    onsearchchange={(q) => (query = q)}
    onpinworkbook={handlePinWorkbook}
    onopenworkbook={(id) => onopenworkbook?.(id)}
  />

  <div class="workspace-content">
    {#if page === "home"}
      <HomeScreen
        {query}
        onopen={(workbookId) => onopenworkbook?.(workbookId)}
        ontemplates={() => onnavigate?.("templates")}
        onopenaichat={() => onopenaichat?.()}
        onworkspaceclick={() => (wsPanelOpen = !wsPanelOpen)}
      />
    {:else if page === "docs"}
      <HomeScreen
        {query}
        onopen={(workbookId) => onopenworkbook?.(workbookId)}
        ontemplates={() => onnavigate?.("templates")}
        onopenaichat={() => onopenaichat?.()}
        onworkspaceclick={() => (wsPanelOpen = !wsPanelOpen)}
      />
    {:else if page === "templates"}
      <TemplatesScreen
        onopen={(workbookId) => onopenworkbook?.(workbookId)}
        onback={goHome}
      />
    {:else if page === "dashboard"}
      <DashboardScreen />
    {:else if page === "admin"}
      <WorkspaceSettingsScreen />
    {:else if page === "admin-console"}
      {#if canOpenAdminConsole}
        <AdminConsoleScreen />
      {:else}
        <PlaceholderScreen
          icon={Lock}
          title="需要管理员权限"
          desc="SQL 控制台只对当前 workspace 的管理员开放。"
          actionLabel="返回首页"
          onaction={goHome}
        />
      {/if}
    {:else if page === "settings"}
      <ProfileScreen />
    {:else if page === "trash"}
      <PlaceholderScreen
        icon={Trash2}
        title="回收站待迁移"
        desc="回收站功能尚未迁移。删除的工作簿将在后续版本可在此恢复。"
        actionLabel="返回首页"
        onaction={goHome}
      />
    {/if}
  </div>
  {#if page === "home"}
    <ActivityPanel />
  {/if}
</div>

<style>
  .workspace-shell {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  .workspace-content {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
  }
</style>
