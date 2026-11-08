<script lang="ts">
  import { onMount } from "svelte";
  import Logo from "../../components/Logo.svelte";
  import { login } from "../../lib/auth";

  let error = $state<string | null>(null);
  let slow = $state(false);

  function callbackErrorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  function returnToFromLocation(): string {
    const value = new URLSearchParams(window.location.search).get("returnTo");
    return value?.startsWith("/") ? value : "/";
  }

  async function startLogin(): Promise<void> {
    error = null;
    slow = false;
    try {
      await login(returnToFromLocation());
    } catch (value) {
      error = callbackErrorMessage(value);
    }
  }

  onMount(() => {
    const timer = window.setTimeout(() => {
      slow = true;
    }, 8000);
    void startLogin();
    return () => window.clearTimeout(timer);
  });
</script>

<main class="auth-page">
  <section class="auth-panel" aria-live="polite">
    <div class="brand"><Logo /></div>
    {#if error}
      <h1>登录失败</h1>
      <p class="message">{error}</p>
      <button type="button" onclick={startLogin}>重试</button>
    {:else}
      <span class="spinner" aria-hidden="true"></span>
      <h1>正在前往安全登录…</h1>
      {#if slow}
        <p class="message">跳转时间比预期更长。若页面一直停在这里，请重试。</p>
        <button type="button" onclick={startLogin}>重试</button>
      {/if}
    {/if}
  </section>
</main>

<style>
  .auth-page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem;
    background: #efebe2;
    color: #221e17;
    font-family: "Plus Jakarta Sans", "Noto Sans SC", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .auth-panel {
    width: min(100%, 24rem);
    border: 1px solid #e6dfd0;
    border-radius: 18px;
    background: #fbfaf5;
    padding: 2.5rem 2rem;
    text-align: center;
    box-shadow: 0 24px 60px -30px rgba(34, 30, 23, 0.28);
  }

  .brand {
    display: flex;
    justify-content: center;
    margin: 0 0 1.5rem;
  }

  .spinner {
    display: inline-block;
    width: 30px;
    height: 30px;
    margin-bottom: 1.25rem;
    border-radius: 50%;
    border: 3px solid rgba(245, 197, 66, 0.24);
    border-top-color: #f5c542;
    animation: auth-spin 0.8s linear infinite;
  }

  @keyframes auth-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  h1 {
    margin: 0;
    font-family: "Spectral", "Noto Serif SC", serif;
    font-size: 1.35rem;
    font-weight: 600;
    line-height: 1.35;
  }

  .message {
    margin: 0.75rem 0 0;
    color: #5c5447;
    font-size: 0.875rem;
    line-height: 1.6;
  }

  button {
    margin-top: 1.25rem;
    border: 0;
    border-radius: 10px;
    background: #161513;
    color: #f6f1e7;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 0.7rem 1.4rem;
  }
</style>
