<script lang="ts">
  import { login } from "../lib/auth.actions";
  import Logo from "../components/Logo.svelte";

  let loading = $state(false);
  let error = $state<string | null>(null);

  async function handleLogin() {
    loading = true;
    error = null;
    try {
      await login();
    } catch (err) {
      error = err instanceof Error ? err.message : "登录失败，请重试";
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-shell">
  <div class="card">
    <div class="brand">
      <Logo />
    </div>

    <h1>欢迎使用 SurrealCK</h1>
    <p class="subtitle">法律金融协作平台</p>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <button class="login-btn primary-btn" onclick={handleLogin} disabled={loading}>
      {#if loading}
        <span class="spinner"></span>正在打开登录页…
      {:else}
        使用组织账号登录
      {/if}
    </button>

    <p class="hint">登录将在系统浏览器中完成，完成后自动返回应用</p>
  </div>
</div>

<style>
  .login-shell {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    background: var(--bg);
  }

  .card {
    display: flex;
    width: 360px;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 32px 36px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .06);
    text-align: center;
  }

  .brand {
    margin-bottom: 8px;
  }

  h1 {
    margin: 0;
    color: var(--text-1);
    font-size: 18px;
    font-weight: 650;
  }

  .subtitle {
    margin: 0;
    color: var(--text-3);
    font-size: 13px;
  }

  .error {
    width: 100%;
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--error-bg);
    color: var(--error);
    font-size: 13px;
    text-align: left;
  }

  .login-btn {
    width: 100%;
    height: 42px;
    margin-top: 4px;
    border-radius: 9px;
    font-size: 14px;
  }

  .login-btn:disabled {
    opacity: .7;
    cursor: not-allowed;
  }

  .hint {
    margin: 0;
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.5;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, .35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
