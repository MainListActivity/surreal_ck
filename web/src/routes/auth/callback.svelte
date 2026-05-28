<script lang="ts">
  import { onMount } from "svelte";
  import { handleCallback } from "../../lib/auth";

  let error = $state<string | null>(null);

  async function completeLogin(): Promise<void> {
    const result = await handleCallback(window.location.href);
    if (result.ok) {
      window.location.replace(result.returnTo);
      return;
    }

    error = result.error;
  }

  onMount(() => {
    void completeLogin();
  });
</script>

<main class="auth-page">
  <section class="auth-panel" aria-live="polite">
    {#if error}
      <p class="eyebrow">OIDC</p>
      <h1>登录回调失败</h1>
      <p class="message">{error}</p>
      <a href="/auth/login">返回登录</a>
    {:else}
      <p class="eyebrow">OIDC</p>
      <h1>正在完成登录</h1>
      <p class="message">正在保存浏览器会话。</p>
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

  a {
    display: inline-block;
    margin-top: 1rem;
    border-radius: 6px;
    background: #1f6feb;
    color: #ffffff;
    font-weight: 650;
    padding: 0.65rem 0.9rem;
    text-decoration: none;
  }
</style>
