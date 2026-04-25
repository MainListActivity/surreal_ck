<script lang="ts">
  import type { Navigate, ScreenId } from "../lib/types";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";
  import Logo from "./Logo.svelte";
  import { logout } from "../lib/auth.actions";

  let { current, navigate }: { current: ScreenId; navigate: Navigate } = $props();

  let docsOpen = $state(false);
  let workspaceIndex = $state(0);
  const workspaces = ["华润置地破产重整", "蓝鼎国际清算"];
</script>

<aside class="side-nav">
  <div class="brand"><Logo /></div>

  <button class="workspace" onclick={() => (workspaceIndex = workspaceIndex === 0 ? 1 : 0)}>
    <span>{workspaces[workspaceIndex]}</span>
    <Icon name="chevronDown" size={13} color="var(--text-3)" />
  </button>

  <button class="new-doc primary-btn" onclick={() => navigate("home")}>
    <Icon name="plus" size={15} color="#fff" />新建文档
  </button>

  <nav>
    <button class:active={current === "home"} onclick={() => navigate("home")}>
      <Icon name="home" size={16} />首页
    </button>
    <button class:active={current === "mydocs"} onclick={() => { docsOpen = !docsOpen; navigate("mydocs"); }}>
      <Icon name="folder" size={16} />
      <span>我的文档</span>
      <span class:rotated={!docsOpen} class="chevron"><Icon name="chevronDown" size={13} /></span>
    </button>
    {#if docsOpen}
      <div class="doc-tree">
        <button onclick={() => navigate("mydocs")}><Icon name="spreadsheet" size={13} color="#00875A" />债权人名册 v3</button>
        <button onclick={() => navigate("mydocs")}><Icon name="spreadsheet" size={13} color="#00875A" />申报截止统计表</button>
        <button onclick={() => navigate("mydocs")}><Icon name="docText" size={13} color="var(--primary)" />异议债权清单</button>
        <button onclick={() => navigate("mydocs")}><Icon name="formIcon" size={13} color="var(--purple)" />公共表单模板库</button>
      </div>
    {/if}
  </nav>

  <div class="bottom-nav">
    <button class:active={current === "admin"} onclick={() => navigate("admin")}><Icon name="settings" size={16} />工作区设置</button>
    <button><Icon name="trash" size={16} />回收站</button>
  </div>

  <div class="user">
    <Avatar name="我" size={30} />
    <div><strong>已登录</strong><span>组织账号</span></div>
    <button class="icon-btn logout-btn" title="退出登录" onclick={logout}>
      <Icon name="logout" size={15} color="var(--text-3)" />
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
    padding: 16px 16px 12px;
    border-bottom: 1px solid var(--border);
  }

  .workspace,
  nav button,
  .bottom-nav button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: calc(100% - 24px);
    margin: 0 12px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }

  .workspace {
    justify-content: space-between;
    margin-top: 10px;
    padding: 7px 10px;
    background: var(--bg);
    font-size: 12px;
    font-weight: 550;
  }

  .workspace span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-doc {
    width: calc(100% - 24px);
    margin: 8px 12px;
    padding: 8px 0;
  }

  nav {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }

  nav button,
  .bottom-nav button {
    padding: 7px 10px;
  }

  nav button:hover,
  .bottom-nav button:hover {
    background: var(--bg);
  }

  button.active {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  nav button > span:first-of-type {
    flex: 1;
  }

  .chevron {
    margin-left: auto;
    transition: transform .15s ease;
  }

  .chevron.rotated {
    transform: rotate(-90deg);
  }

  .doc-tree {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 8px 6px 20px;
  }

  .doc-tree button {
    width: 100%;
    margin: 0;
    padding: 5px 7px;
    font-size: 12px;
  }

  .bottom-nav {
    padding: 4px 0;
  }

  .user {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
  }

  .user div {
    min-width: 0;
    flex: 1;
  }

  .user strong,
  .user span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user strong {
    color: var(--text-1);
    font-size: 12px;
  }

  .user span {
    color: var(--text-3);
    font-size: 11px;
  }
</style>
