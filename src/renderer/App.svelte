<script lang="ts">
  import { onMount } from "svelte";
  import SideNav from "./components/SideNav.svelte";
  import AdminConsoleScreen from "./screens/AdminConsoleScreen.svelte";
  import AdminScreen from "./screens/AdminScreen.svelte";
  import EditorScreen from "./screens/EditorScreen.svelte";
  import HomeScreen from "./screens/HomeScreen.svelte";
  import LoginScreen from "./screens/LoginScreen.svelte";
  import MyDocsScreen from "./screens/MyDocsScreen.svelte";
  import PublicFormScreen from "./screens/PublicFormScreen.svelte";
  import StateScreen from "./screens/StateScreen.svelte";
  import TemplatesScreen from "./screens/TemplatesScreen.svelte";
  import { auth, applyAuthState } from "./lib/auth.svelte";
  import { appState } from "./lib/app-state.svelte";
  import { rpc } from "./lib/rpc";
  import { editorStore } from "./lib/editor.svelte";
  import { editorUi } from "./features/editor/lib/editor-ui.svelte";
  import LeaveDraftModal from "./features/editor/modals/LeaveDraftModal.svelte";
  import type { RouteState, ScreenId } from "./lib/types";

  const navScreens = new Set<ScreenId>(["home", "mydocs", "templates", "admin", "state-empty"]);
  const validStoredScreens = new Set<ScreenId>([
    "home",
    "mydocs",
    "editor",
    "form",
    "form-success",
    "templates",
    "admin",
    "state-empty",
    "state-offline",
    "state-noperm",
  ]);

  let route = $state<RouteState>(readInitialRoute());
  let lastBootstrapKey = $state("");

  $effect(() => {
    const key = `${auth.loggedIn}:${auth.offlineMode ?? false}`;
    if (auth.loggedIn || auth.offlineMode) {
      if (key !== lastBootstrapKey) {
        lastBootstrapKey = key;
        void appState.load();
      }
    } else {
      lastBootstrapKey = key;
      appState.reset();
    }
  });

  onMount(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        navigate("admin-console");
      }
    };

    // 关闭窗口/刷新前若仍有未保存草稿，触发原生确认
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (route.screen === "editor" && editorStore.pendingDraftCount > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    void rpc.request("getAuthState", {}).then(applyAuthState);

    window.addEventListener("keydown", onKeydown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  });

  function readInitialRoute(): RouteState {
    try {
      const raw = localStorage.getItem("srk_route");
      if (raw) {
        const parsed = JSON.parse(raw) as RouteState;
        // editor 页面若无 workbookId 则回退 home
        if (parsed.screen === "editor" && !parsed.workbookId) {
          return { screen: "home" };
        }
        if (validStoredScreens.has(parsed.screen)) return parsed;
      }
    } catch {
      // ignore
    }
    return { screen: "home" };
  }

  function commitNavigate(next: RouteState) {
    route = next;
    try {
      if (next.screen === "admin-console") {
        localStorage.removeItem("srk_route");
      } else {
        localStorage.setItem("srk_route", JSON.stringify(next));
      }
    } catch {
      // WebView storage can be unavailable in tests.
    }
  }

  /**
   * 集中拦截：从 editor 出去（换 screen / 换 workbookId）且当前有未保存的 draft 行时，
   * 弹出确认弹窗，用户选择放弃后才真的导航。所有调用 navigate 的入口（topbar、SideNav、键盘快捷键等）
   * 自动获得保护，无需各自重复实现。
   */
  function navigate(screen: ScreenId, params?: Omit<RouteState, "screen">) {
    const next: RouteState = { screen, ...params };
    const leavingWorkbook =
      route.screen === "editor" &&
      (next.screen !== "editor" || next.workbookId !== route.workbookId);

    if (leavingWorkbook && editorStore.pendingDraftCount > 0) {
      const draftCount = editorStore.pendingDraftCount;
      editorUi.askLeaveConfirm(draftCount, async () => {
        const saved = await editorStore.commitValidDrafts();
        if (!saved) return;
        editorStore.discardAllDrafts();
        editorUi.closeLeaveConfirm();
        commitNavigate(next);
      });
      return;
    }

    commitNavigate(next);
  }
</script>

<div class="app-shell">
  {#if !auth.loggedIn && !auth.offlineMode}
    <LoginScreen />
  {:else}
    {#if auth.offlineMode}
      <div class="offline-banner">
        <span class="offline-icon">⚠</span>
        离线模式 — 数据同步暂停，当前为只读视图
        <button class="login-link" onclick={() => { applyAuthState({ loggedIn: false }); }}>重新登录</button>
      </div>
    {/if}

    <div class="app-body">
      {#if navScreens.has(route.screen)}
        <SideNav current={route.screen} {navigate} />
      {/if}

      <main class="app-main" class:fullscreen={!navScreens.has(route.screen)}>
        {#if route.screen === "home"}
          <HomeScreen {navigate} />
        {:else if route.screen === "mydocs"}
          <MyDocsScreen {navigate} />
        {:else if route.screen === "editor"}
          <EditorScreen {navigate} workbookId={route.workbookId} />
        {:else if route.screen === "form"}
          <PublicFormScreen {navigate} />
        {:else if route.screen === "form-success"}
          <PublicFormScreen mode="success" {navigate} />
        {:else if route.screen === "templates"}
          <TemplatesScreen {navigate} />
        {:else if route.screen === "admin"}
          <AdminScreen {navigate} />
        {:else if route.screen === "admin-console"}
          <AdminConsoleScreen {navigate} />
        {:else}
          <StateScreen kind={route.screen} {navigate} />
        {/if}
      </main>
    </div>
  {/if}

  {#if editorUi.leaveConfirm.open}
    <LeaveDraftModal />
  {/if}
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
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  .offline-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 16px;
    background: var(--warning-bg);
    border-bottom: 1px solid #ffd591;
    color: var(--warning);
    font-size: 12px;
    font-weight: 500;
    flex-shrink: 0;
    z-index: 100;
  }

  .offline-icon {
    font-size: 13px;
  }

  .login-link {
    margin-left: auto;
    padding: 3px 10px;
    border: 1px solid var(--warning);
    border-radius: 5px;
    background: transparent;
    color: var(--warning);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .login-link:hover {
    background: rgba(255, 125, 0, .08);
  }

  .app-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
