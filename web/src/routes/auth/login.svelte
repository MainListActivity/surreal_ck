<script lang="ts">
  import { onMount } from "svelte";
  import { login } from "../../lib/auth";

  let error = $state<string | null>(null);

  function callbackErrorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  function returnToFromLocation(): string {
    const value = new URLSearchParams(window.location.search).get("returnTo");
    return value?.startsWith("/") ? value : "/";
  }

  async function startLogin(): Promise<void> {
    error = null;
    try {
      await login(returnToFromLocation());
    } catch (value) {
      error = callbackErrorMessage(value);
    }
  }

  onMount(() => {
    void startLogin();
  });
</script>

<main class="auth-page">
  <section class="auth-panel" aria-live="polite">
    {#if error}
      <p class="eyebrow">OIDC</p>
      <h1>登录失败</h1>
      <p class="message">{error}</p>
      <button type="button" onclick={startLogin}>重试</button>
    {:else}
      <p class="eyebrow">OIDC</p>
      <h1>正在跳转登录</h1>
      <p class="message">请在身份提供方完成登录。</p>
    {/if}
  </section>
</main>

<style>
  .auth-page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem;
    background: #f7f8fa;
    color: #16181d;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .auth-panel {
    width: min(100%, 28rem);
    border: 1px solid #d9dee7;
    border-radius: 8px;
    background: #ffffff;
    padding: 1.5rem;
  }

  .eyebrow {
    margin: 0 0 0.5rem;
    color: #546071;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
    line-height: 1.25;
  }

  .message {
    margin: 0.75rem 0 0;
    color: #3e4654;
    line-height: 1.6;
  }

  button {
    margin-top: 1rem;
    border: 0;
    border-radius: 6px;
    background: #1f6feb;
    color: #ffffff;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 0.65rem 0.9rem;
  }
</style>
