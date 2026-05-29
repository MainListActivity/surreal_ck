<script lang="ts">
  import { onMount } from "svelte";
  import LoginRoute from "./routes/auth/login.svelte";
  import CallbackRoute from "./routes/auth/callback.svelte";
  import WorkspaceSwitcher from "./components/WorkspaceSwitcher.svelte";
  import { getSession, isAuthenticated, logout, refresh, requireAuthenticatedRoute } from "./lib/auth";

  type RouteKind = "home" | "login" | "callback";

  const REFRESH_INTERVAL_MS = 60_000;

  let route = $state<RouteKind>("home");
  let ready = $state(false);
  let session = $state(getSession());

  function currentPath(): string {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function routeFor(pathname: string): RouteKind {
    if (pathname === "/auth/login") return "login";
    if (pathname === "/auth/callback") return "callback";
    return "home";
  }

  function syncSession(): void {
    session = getSession();
  }

  async function refreshSession(): Promise<void> {
    await refresh();
    syncSession();
  }

  async function handleLogout(): Promise<void> {
    await logout();
  }

  onMount(() => {
    route = routeFor(window.location.pathname);

    if (route !== "home") {
      ready = true;
      return;
    }

    if (!requireAuthenticatedRoute(currentPath())) return;

    ready = true;
    syncSession();
    void refreshSession();

    const refreshTimer = window.setInterval(() => {
      void refreshSession();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(refreshTimer);
  });
</script>

{#if route === "login"}
  <LoginRoute />
{:else if route === "callback"}
  <CallbackRoute />
{:else if ready && isAuthenticated()}
  <main class="app-shell">
    <header>
      <div>
        <p class="eyebrow">surreal-ck</p>
        <h1>工作区</h1>
      </div>
      <div class="header-actions">
        <WorkspaceSwitcher />
        <button type="button" onclick={handleLogout}>退出</button>
      </div>
    </header>

    <section class="workspace-summary">
      <h2>当前会话</h2>
      {#if session}
        <dl>
          <div>
            <dt>状态</dt>
            <dd>已登录</dd>
          </div>
          <div>
            <dt>Token 过期时间</dt>
            <dd>{new Date(session.expiresAt * 1000).toLocaleString()}</dd>
          </div>
        </dl>
      {:else}
        <p>会话尚未就绪。</p>
      {/if}
    </section>
  </main>
{:else}
  <main class="loading" aria-live="polite">正在检查登录状态。</main>
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #f7f8fa;
    color: #16181d;
  }

  .app-shell,
  .loading {
    box-sizing: border-box;
    min-height: 100vh;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .app-shell {
    padding: 2rem;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid #d9dee7;
    padding-bottom: 1rem;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .eyebrow {
    margin: 0 0 0.25rem;
    color: #546071;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h1,
  h2 {
    margin: 0;
    line-height: 1.25;
  }

  h1 {
    font-size: 1.6rem;
  }

  h2 {
    font-size: 1.1rem;
  }

  button {
    border: 1px solid #c8d0dc;
    border-radius: 6px;
    background: #ffffff;
    color: #16181d;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 0.55rem 0.8rem;
  }

  .workspace-summary {
    max-width: 48rem;
    padding-top: 1.5rem;
  }

  dl {
    display: grid;
    gap: 0.85rem;
    margin: 1rem 0 0;
  }

  dl div {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) 1fr;
    gap: 1rem;
    border-bottom: 1px solid #e5e9f0;
    padding-bottom: 0.85rem;
  }

  dt {
    color: #546071;
    font-weight: 650;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .loading {
    display: grid;
    place-items: center;
    padding: 2rem;
  }
</style>
