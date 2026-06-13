<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import Logo from "./Logo.svelte";
  import { Plus, House, Coins, Folder, Tag, Settings, Hash, Trash2, LogOut } from "@lucide/svelte";
  import WorkspaceSwitcher from "./WorkspaceSwitcher.svelte";
  import { logout } from "../lib/auth";
  import { getCurrentUser } from "../lib/workspace-store.svelte";
  import {
    canWriteSharedStructure as canWriteSharedStructureFn,
    isWorkspaceAdmin as isWorkspaceAdminFn,
  } from "../lib/permissions.svelte";
  import type { WorkspacePage } from "../lib/route";

  // 新架构 SideNav：保留 legacy 全部可见入口（首页 / 仪表盘 / 我的文档 / 工作区设置 /
  // 回收站 / 个人设置 / 退出 / 新建文档 / workspace 切换）。
  // legacy 的文件夹树 + 拖拽依赖已废弃的 folder 模型与后端 RPC，新模型下 workbook 表不带
  // folder（跨 workspace 靠 db 边界隔离），故「我的文档」退化为一个导航入口指向 docs 页，
  // 目录树留后续 issue。
  let {
    page,
    onnavigate,
    onnewdoc,
  }: {
    page: WorkspacePage;
    onnavigate?: (page: WorkspacePage) => void;
    onnewdoc?: () => void;
  } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  const canOpenAdminConsole = $derived(isWorkspaceAdminFn());
  const user = $derived(getCurrentUser());
  const userName = $derived(user?.name || user?.email || "我");
  const userMeta = $derived(user?.email || "组织账号");

  function go(target: WorkspacePage) {
    onnavigate?.(target);
  }
</script>

<aside class="side-nav">
  <button class="brand" onclick={() => go("home")}><Logo /></button>

  <div class="ws-slot">
    <WorkspaceSwitcher />
  </div>

  <button
    class="new-doc primary-btn"
    disabled={!canWriteSharedStructure}
    title={canWriteSharedStructure ? "新建文档" : "需要管理员权限"}
    onclick={() => onnewdoc?.()}
  >
    <Plus size={15} color="#fff" />新建文档
  </button>

  <nav>
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

  <div class="bottom-nav">
    <button class:active={page === "admin"} onclick={() => go("admin")}>
      <Settings size={16} />工作区设置
    </button>
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

  <div class="user" class:active={page === "settings"}>
    <button class="user-main" title="打开个人设置" onclick={() => go("settings")}>
      <Avatar name={userName} size={30} />
      <div><strong>{userName}</strong><span>{userMeta}</span></div>
    </button>
    <button class="icon-btn logout-btn" title="退出登录" onclick={() => void logout()}>
      <LogOut size={15} color="var(--text-3)" />
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

  .ws-slot {
    padding: 10px 12px 0;
  }

  .ws-slot :global(.switcher),
  .ws-slot :global(.trigger) {
    width: 100%;
  }

  .ws-slot :global(.trigger) {
    justify-content: space-between;
  }

  .new-doc {
    width: calc(100% - 24px);
    margin: 8px 12px;
    padding: 8px 0;
    cursor: pointer;
  }

  .new-doc:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  nav {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }

  nav button,
  .bottom-nav button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: calc(100% - 24px);
    margin: 0 12px;
    padding: 7px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  nav button:hover,
  .bottom-nav button:hover:not(:disabled) {
    background: var(--bg);
  }

  .bottom-nav button:disabled {
    cursor: not-allowed;
    opacity: .52;
  }

  button.active {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .bottom-nav {
    padding: 4px 0;
  }

  .user {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
  }

  .user.active {
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
    cursor: pointer;
  }

  .user-main:hover {
    background: var(--bg);
  }

  .user-main div {
    min-width: 0;
    flex: 1;
  }

  .user-main strong,
  .user-main span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-main strong {
    color: var(--text-1);
    font-size: 12px;
  }

  .user-main span {
    color: var(--text-3);
    font-size: 11px;
  }

  .logout-btn {
    flex-shrink: 0;
  }
</style>
