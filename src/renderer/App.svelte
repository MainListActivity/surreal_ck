<script lang="ts">
  import SideNav from "./components/SideNav.svelte";
  import AdminScreen from "./screens/AdminScreen.svelte";
  import EditorScreen from "./screens/EditorScreen.svelte";
  import HomeScreen from "./screens/HomeScreen.svelte";
  import MyDocsScreen from "./screens/MyDocsScreen.svelte";
  import PublicFormScreen from "./screens/PublicFormScreen.svelte";
  import StateScreen from "./screens/StateScreen.svelte";
  import TemplatesScreen from "./screens/TemplatesScreen.svelte";
  import type { ScreenId } from "./lib/types";

  let screen: ScreenId = $state(readInitialScreen());

  const navScreens = new Set<ScreenId>(["home", "mydocs", "templates", "admin", "state-empty"]);

  function readInitialScreen(): ScreenId {
    try {
      return (localStorage.getItem("srk_screen") as ScreenId | null) ?? "home";
    } catch {
      return "home";
    }
  }

  function navigate(next: ScreenId) {
    screen = next;
    try {
      localStorage.setItem("srk_screen", next);
    } catch {
      // WebView storage can be unavailable in tests.
    }
  }
</script>

<div class="app-shell">
  {#if navScreens.has(screen)}
    <SideNav current={screen} {navigate} />
  {/if}

  <main class="app-main" class:fullscreen={!navScreens.has(screen)}>
    {#if screen === "home"}
      <HomeScreen {navigate} />
    {:else if screen === "mydocs"}
      <MyDocsScreen {navigate} />
    {:else if screen === "editor"}
      <EditorScreen {navigate} />
    {:else if screen === "form"}
      <PublicFormScreen {navigate} />
    {:else if screen === "form-success"}
      <PublicFormScreen mode="success" {navigate} />
    {:else if screen === "templates"}
      <TemplatesScreen {navigate} />
    {:else if screen === "admin"}
      <AdminScreen {navigate} />
    {:else}
      <StateScreen kind={screen} {navigate} />
    {/if}
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body),
  :global(#app) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
  }

  :global(body) {
    color: var(--text-1);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  :global(:root) {
    --primary: #1664ff;
    --primary-light: #ebf0ff;
    --primary-hover: #0e4fcc;
    --bg: #f2f3f5;
    --surface: #fff;
    --soft: #f7f8fa;
    --text-1: #1d2129;
    --text-2: #4e5969;
    --text-3: #86909c;
    --border: #e5e6eb;
    --border-dark: #c9cdd4;
    --success: #00b42a;
    --success-bg: #e8ffea;
    --warning: #ff7d00;
    --warning-bg: #fff7e8;
    --error: #f53f3f;
    --error-bg: #ffece8;
    --purple: #7b61ff;
    --purple-bg: #f0edff;
  }

  :global(button),
  :global(input),
  :global(select),
  :global(textarea) {
    font: inherit;
  }

  :global(button) {
    cursor: pointer;
  }

  :global(svg) {
    display: inline-block;
    flex-shrink: 0;
    vertical-align: middle;
  }

  :global(::-webkit-scrollbar) {
    width: 6px;
    height: 6px;
  }

  :global(::-webkit-scrollbar-thumb) {
    border-radius: 3px;
    background: var(--border-dark);
  }

  :global(.primary-btn),
  :global(.secondary-btn),
  :global(.ghost-btn),
  :global(.icon-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 7px;
    font-size: 13px;
    font-weight: 550;
  }

  :global(.primary-btn) {
    border: 0;
    background: var(--primary);
    color: #fff;
  }

  :global(.primary-btn:hover) {
    background: var(--primary-hover);
  }

  :global(.secondary-btn) {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-2);
  }

  :global(.ghost-btn),
  :global(.icon-btn) {
    border: 0;
    background: transparent;
    color: var(--text-2);
  }

  :global(.ghost-btn:hover),
  :global(.icon-btn:hover) {
    background: var(--bg);
  }

  :global(.icon-btn) {
    width: 32px;
    height: 32px;
    padding: 0;
  }

  .app-shell {
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  .app-main {
    display: flex;
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }

  .app-main.fullscreen {
    background: var(--surface);
  }
</style>
