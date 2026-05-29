<script lang="ts">
  import SideNav from "../components/SideNav.svelte";
  import HomeScreen from "./HomeScreen.svelte";
  import PlaceholderScreen from "./PlaceholderScreen.svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import { canWriteSharedStructure as canWriteSharedStructureFn } from "../lib/permissions.svelte";
  import type { WorkspacePage } from "../lib/route";

  // workspace 首页 shell：左侧 SideNav + 右侧按 page 切换内容。
  // 已迁功能（首页 workbook 列表）直接可用；未迁页面（模板/仪表盘/工作区设置/个人设置/
  // 回收站）给明确占位，入口不丢——这是 D2-09 删除 web/legacy/ 前的安全阀。
  let {
    slug,
    page,
    onopenworkbook,
    onnavigate,
  }: {
    slug: string;
    page: WorkspacePage;
    onopenworkbook?: (workbookId: string) => void;
    onnavigate?: (page: WorkspacePage) => void;
  } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());

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
    onnavigate={(target) => onnavigate?.(target)}
    onnewdoc={() => void createBlankAndOpen()}
  />

  <div class="workspace-content">
    {#if page === "home"}
      <HomeScreen
        onopen={(workbookId) => onopenworkbook?.(workbookId)}
        ontemplates={() => onnavigate?.("templates")}
      />
    {:else if page === "docs"}
      <HomeScreen
        onopen={(workbookId) => onopenworkbook?.(workbookId)}
        ontemplates={() => onnavigate?.("templates")}
      />
    {:else if page === "templates"}
      <PlaceholderScreen
        icon="tag"
        title="模板创建待迁移"
        desc="模板库依赖旧版接口，正在迁移中。当前请先用「空白文档」创建工作簿，迁移完成后将在此提供案件管理、法律实体追踪等模板。"
        actionLabel="返回首页"
        onaction={goHome}
      />
    {:else if page === "dashboard"}
      <PlaceholderScreen
        icon="coins"
        title="仪表盘即将上线"
        desc="数据仪表盘已规划在后续迭代（D3）中迁移。入口已保留，敬请期待。"
        actionLabel="返回首页"
        onaction={goHome}
      />
    {:else if page === "admin"}
      <PlaceholderScreen
        icon="settings"
        title="工作区设置待迁移"
        desc="成员管理与工作区设置将接入 Workspace Scope Module，正在迁移中。如需切换或新建工作区，请使用左上角的工作区切换器。"
        actionLabel="返回首页"
        onaction={goHome}
      />
    {:else if page === "settings"}
      <PlaceholderScreen
        icon="settings"
        title="个人设置待迁移"
        desc="个人 / AI / 向量化设置原依赖旧版接口，新架构尚未接入。入口已保留，迁移完成后在此提供。"
        actionLabel="返回首页"
        onaction={goHome}
      />
    {:else if page === "trash"}
      <PlaceholderScreen
        icon="trash"
        title="回收站待迁移"
        desc="回收站功能尚未迁移。删除的工作簿将在后续版本可在此恢复。"
        actionLabel="返回首页"
        onaction={goHome}
      />
    {/if}
  </div>
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
