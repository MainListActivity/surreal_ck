<script lang="ts">
  import { onMount } from "svelte";
  import Logo from "../../components/Logo.svelte";
  import { handleCallback } from "../../lib/auth";
  import {
    isFramed,
    postAuthEmbedMessage,
    sanitizeReturnTo,
  } from "../../lib/auth-embed-protocol";

  let error = $state<string | null>(null);
  let embeddedDone = $state(false);
  let started = false;

  async function completeLogin(): Promise<void> {
    const result = await handleCallback(window.location.href);
    if (result.ok) {
      if (isFramed()) {
        postAuthEmbedMessage({
          source: "maplayer-auth",
          type: "success",
          returnTo: sanitizeReturnTo(result.returnTo),
        });
        embeddedDone = true;
        return;
      }
      window.location.replace(result.returnTo);
      return;
    }

    if (isFramed()) {
      postAuthEmbedMessage({
        source: "maplayer-auth",
        type: "error",
        message: result.error,
      });
    }
    error = result.error;
  }

  onMount(() => {
    if (started) return;
    started = true;
    void completeLogin();
  });
</script>

<main class="auth-page" class:embedded={isFramed()}>
  <section class="auth-panel" class:compact={isFramed()} aria-live="polite">
    {#if embeddedDone}
      <div class="brand"><Logo /></div>
      <span class="check" aria-hidden="true">✓</span>
      <h1>登录成功</h1>
      <p class="message">正在进入工作空间…</p>
    {:else if error}
      {#if !isFramed()}<div class="brand"><Logo /></div>{/if}
      <h1>登录回调失败</h1>
      <p class="message">{error}</p>
      <a href="/auth/login">返回登录</a>
    {:else}
      <div class="brand"><Logo /></div>
      <span class="spinner" aria-hidden="true"></span>
      <h1>正在进入工作空间…</h1>
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

  .auth-page.embedded {
    min-height: auto;
    padding: 2rem 1rem;
    background: transparent;
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

  .auth-panel.compact {
    border: 0;
    background: transparent;
    box-shadow: none;
    padding: 0.5rem;
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

  .check {
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin-bottom: 1rem;
    border-radius: 50%;
    background: #161513;
    color: #f5c542;
    font-size: 1.25rem;
    font-weight: 700;
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

  a {
    display: inline-block;
    margin-top: 1.25rem;
    border-radius: 10px;
    background: #161513;
    color: #f6f1e7;
    font-weight: 600;
    padding: 0.7rem 1.4rem;
    text-decoration: none;
  }
</style>
