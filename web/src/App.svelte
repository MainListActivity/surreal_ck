<script lang="ts">
  import { onMount } from "svelte";
  import LoginRoute from "./routes/auth/login.svelte";
  import CallbackRoute from "./routes/auth/callback.svelte";
  import AiDrawer from "./components/AiDrawer.svelte";
  import { Sparkles, ClipboardList } from "@lucide/svelte";
  import EditorScreen from "./screens/EditorScreen.svelte";
  import WorkspaceScreen from "./screens/WorkspaceScreen.svelte";
  import NoWorkspaceScreen from "./screens/NoWorkspaceScreen.svelte";
  import PlaceholderScreen from "./screens/PlaceholderScreen.svelte";
  import { isAuthenticated, logout, refresh, requireAuthenticatedRoute } from "./lib/auth";
  import { editorPath, parseRoute, workspacePath, type Route, type WorkspacePage } from "./lib/route";
  import { bootstrapWorkspace } from "./lib/switch-workspace.svelte";

  const REFRESH_INTERVAL_MS = 60_000;

  let route = $state<Route>({ kind: "home" });
  let ready = $state(false);
  // workspace 直连建立状态：进入任何业务路由前必须先 bootstrapWorkspace 把连接拉起来。
  // "empty" = 账号还没有任何 workspace（区别于真正的连接错误），由 NoWorkspaceScreen 接管。
  let wsState = $state<"idle" | "connecting" | "ready" | "error" | "empty">("idle");
  let wsError = $state<string | null>(null);
  // 空状态下是否允许创建（来自后端 listWorkspaces 的 canCreate）。
  let wsCanCreate = $state(false);
  // 上一次已 bootstrap 的 slug；slug 不变就不重复连库。
  let bootstrappedSlug = $state<string | null>(null);
  let aiDrawerOpen = $state(false);

  function currentPath(): string {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function syncRoute(): void {
    route = parseRoute(window.location.pathname);
  }

  function navigateTo(path: string): void {
    window.history.pushState({}, "", path);
    syncRoute();
    void ensureWorkspace();
  }

  function navigatePage(slug: string, page: WorkspacePage): void {
    navigateTo(workspacePath(slug, page));
  }

  function openWorkbook(slug: string, workbookId: string): void {
    navigateTo(editorPath(slug, workbookId));
  }

  function openAiDrawer(): void {
    aiDrawerOpen = true;
  }

  async function refreshSession(): Promise<string | null> {
    return refresh();
  }

  /** 按当前路由建立 / 复用 workspace 直连；home 落地后跳到具体 /w/:slug。 */
  async function ensureWorkspace(): Promise<void> {
    const r = route;
    if (r.kind === "login" || r.kind === "callback" || r.kind === "form" || r.kind === "form-success") {
      return;
    }

    const slug = r.kind === "workspace" || r.kind === "editor" ? r.slug : undefined;
    if (slug && slug === bootstrappedSlug && wsState === "ready") return;

    wsState = "connecting";
    wsError = null;
    let result;
    try {
      result = await bootstrapWorkspace(slug);
    } catch (error) {
      wsState = "error";
      wsError = error instanceof Error ? error.message : "工作区连接失败。";
      return;
    }
    if (!result.ok) {
      // 账号无任何 workspace 不是连接错误：交给 NoWorkspaceScreen 引导创建 / 提示邀请。
      if (result.reason === "none") {
        wsCanCreate = result.canCreate;
        wsState = "empty";
        return;
      }
      wsState = "error";
      wsError =
        result.reason === "forbidden"
          ? "无权访问该工作区。"
          : result.reason === "refresh-failed"
            ? "会话已过期，请重新登录。"
            : (result.message ?? "工作区连接失败。");
      return;
    }

    bootstrappedSlug = result.slug;
    wsState = "ready";

    // 根路径 / 缺 slug：连上后跳到具体 workspace URL，让地址栏可分享。
    if (r.kind === "home") {
      window.history.replaceState({}, "", workspacePath(result.slug));
      syncRoute();
    }
  }

  onMount(() => {
    syncRoute();

    if (route.kind === "login" || route.kind === "callback") {
      ready = true;
      return;
    }

    if (route.kind === "form" || route.kind === "form-success") {
      ready = true;
      return;
    }

    if (!requireAuthenticatedRoute(currentPath())) return;

    ready = true;
    void (async () => {
      const token = await refreshSession();
      if (!token) return;
      await ensureWorkspace();
    })();

    const handlePopState = () => {
      syncRoute();
      void ensureWorkspace();
    };
    const refreshTimer = window.setInterval(() => {
      void refreshSession();
    }, REFRESH_INTERVAL_MS);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener("popstate", handlePopState);
    };
  });
</script>

{#if route.kind === "login"}
  <LoginRoute />
{:else if route.kind === "callback"}
  <CallbackRoute />
{:else if route.kind === "form" || route.kind === "form-success"}
  <main class="standalone">
    <PlaceholderScreen
      icon={ClipboardList}
      title={route.kind === "form-success" ? "提交成功" : "公开表单待迁移"}
      desc={route.kind === "form-success"
        ? "表单已提交。公开表单发布功能正在迁移中。"
        : "公开表单发布功能尚未迁移。如需录入数据，请登录后在工作簿内操作。"}
      actionLabel="前往登录"
      onaction={() => navigateTo("/auth/login")}
    />
  </main>
{:else if ready && isAuthenticated()}
  {#if wsState === "connecting" || wsState === "idle"}
    <main class="loading" aria-live="polite">正在连接工作区…</main>
  {:else if wsState === "empty"}
    <NoWorkspaceScreen
      canCreate={wsCanCreate}
      oncreated={() => {
        // 创建对话框已 enterWorkspace + navigate /w/:slug；重新同步路由并 bootstrap 进入。
        syncRoute();
        void ensureWorkspace();
      }}
    />
  {:else if wsState === "error"}
    <main class="loading" aria-live="polite">
      <p>{wsError}</p>
      <button type="button" onclick={() => void logout()}>重新登录</button>
    </main>
  {:else if route.kind === "editor"}
    {@const r = route}
    <div class="app-with-ai">
      <main class="editor-shell app-main">
        <EditorScreen
          slug={r.slug}
          workbookId={r.workbookId}
          sheetId={r.sheetId}
          onback={() => navigatePage(r.slug, "home")}
          onroute={navigateTo}
        />
      </main>
      <AiDrawer
        open={aiDrawerOpen}
        workspaceSlug={r.slug}
        routeScreen="editor"
        onclose={() => (aiDrawerOpen = false)}
      />
      {#if !aiDrawerOpen}
        <button type="button" class="ai-launcher" aria-label="AI 助手" onclick={openAiDrawer}>
          <Sparkles size={16} color="#fff" />
          <span>AI</span>
        </button>
      {/if}
    </div>
  {:else if route.kind === "workspace"}
    {@const r = route}
    <div class="app-with-ai">
      <main class="app-main">
        <WorkspaceScreen
          slug={r.slug}
          page={r.page}
          onopenworkbook={(workbookId) => openWorkbook(r.slug, workbookId)}
          onopenaichat={openAiDrawer}
          onnavigate={(page) => navigatePage(r.slug, page)}
        />
      </main>
      <AiDrawer
        open={aiDrawerOpen}
        workspaceSlug={r.slug}
        routeScreen={r.page === "dashboard" ? "dashboard" : "workspace"}
        onclose={() => (aiDrawerOpen = false)}
      />
      {#if !aiDrawerOpen}
        <button type="button" class="ai-launcher" aria-label="AI 助手" onclick={openAiDrawer}>
          <Sparkles size={16} color="#fff" />
          <span>AI</span>
        </button>
      {/if}
    </div>
  {:else}
    <main class="loading" aria-live="polite">正在进入工作区…</main>
  {/if}
{:else}
  <main class="loading" aria-live="polite">正在检查登录状态。</main>
{/if}

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
  }

  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--text-1);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }

  :global(:root) {
    /* 卯豆 暖绿品牌（纸质米色背景 + 嫩芽绿）。
       token 名沿用旧蓝色主题，映射到暖色系，整站随之换肤。 */
    --primary: #2f7a4c;
    --primary-light: #e7f0e4;
    --primary-hover: #266340;
    --brand-strong: #266340;
    --brand-mid: #6db87a;
    --bg: #efebe2;
    --surface: #fbfaf5;
    --surface-2: #ffffff;
    --soft: #ece7db;
    --text-1: #221e17;
    --text-2: #5c5447;
    --text-3: #9a917f;
    --border: #e6dfd0;
    --border-dark: #dad1be;
    --success: #2f7a4c;
    --success-bg: #e7f0e4;
    --warning: #cc6b3a;
    --warning-bg: #f7e7da;
    --error: #c0492b;
    --error-bg: #f6e3dc;
    --purple: #8a5a8f;
    --purple-bg: #f0e7f1;
    /* 种子/陶土暖橙强调色 */
    --seed: #cc6b3a;
    --seed-strong: #b65b2e;
    --seed-soft: #f7e7da;
    --font-serif: "Spectral", "Noto Serif SC", serif;
    --font-sans: "Plus Jakarta Sans", "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  :global(button),
  :global(input),
  :global(select),
  :global(textarea) {
    font: inherit;
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
    cursor: pointer;
  }

  .editor-shell,
  .standalone,
  .loading {
    box-sizing: border-box;
    min-height: 100vh;
    font-family: var(--font-sans);
  }

  .editor-shell {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  .app-with-ai {
    position: relative;
    display: flex;
    height: 100vh;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-sans);
  }

  .app-main {
    min-width: 0;
    flex: 1;
  }

  .ai-launcher {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 25;
    display: inline-flex;
    height: 42px;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    background: var(--primary);
    color: #fff;
    box-shadow: 0 10px 24px rgba(22, 100, 255, .24);
    cursor: pointer;
    font-size: 13px;
    font-weight: 650;
  }

  .ai-launcher:hover {
    background: var(--primary-hover);
  }

  .standalone {
    display: flex;
  }

  .loading {
    display: grid;
    place-items: center;
    gap: 1rem;
    padding: 2rem;
  }

  .loading button {
    border: 1px solid #c8d0dc;
    border-radius: 6px;
    background: #fff;
    color: #16181d;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 0.55rem 0.9rem;
  }
</style>
