<script lang="ts">
  import { onMount } from "svelte";
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import { appApi } from "../lib/app-api";
  import { appState } from "../lib/app-state.svelte";
  import type { Navigate } from "../lib/types";

  let { navigate: _navigate }: { navigate: Navigate } = $props();

  let retentionDays = $state(30);
  let draftRetentionDays = $state("30");
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let savedAt = $state<string | null>(null);

  const userName = $derived(appState.user?.displayName || appState.user?.name || "未命名用户");
  const userEmail = $derived(appState.user?.email || "未绑定邮箱");
  const workspaceName = $derived(appState.workspace?.name || "默认工作区");
  const dirty = $derived(String(retentionDays) !== draftRetentionDays.trim());
  const parsedRetention = $derived(Number.parseInt(draftRetentionDays, 10));
  const invalidRetention = $derived(
    !Number.isFinite(parsedRetention) || parsedRetention < 1 || parsedRetention > 3650
  );

  onMount(() => {
    void loadSettings();
  });

  async function loadSettings() {
    loading = true;
    error = null;
    try {
      const result = await appApi.getSettings();
      if (!result.ok) {
        error = result.message;
        return;
      }
      retentionDays = result.data.observability.retentionDays;
      draftRetentionDays = String(retentionDays);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function saveSettings() {
    if (invalidRetention || saving) return;
    saving = true;
    error = null;
    savedAt = null;
    try {
      const result = await appApi.saveSettings(parsedRetention);
      if (!result.ok) {
        error = result.message;
        return;
      }
      retentionDays = result.data.observability.retentionDays;
      draftRetentionDays = String(retentionDays);
      savedAt = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<section class="settings">
  <aside>
    <div class="title">个人设置</div>
    <button class="selected"><Icon name="settings" size={15} />偏好设置</button>
  </aside>

  <div class="main">
    <header>
      <div>
        <h2>设置</h2>
        <p>{workspaceName}</p>
      </div>
      <button class="secondary-btn" onclick={loadSettings} disabled={loading || saving}>
        <Icon name="refresh" size={14} />刷新
      </button>
    </header>

    <div class="profile-panel">
      <Avatar name={userName} size={48} />
      <div>
        <strong>{userName}</strong>
        <span>{userEmail}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div>
          <h3>观测数据</h3>
          <p>控制 Mastra traces、事件和调试数据在本机数据库中的保留时间。</p>
        </div>
        <span class="status" class:dirty>{dirty ? "未保存" : "已同步"}</span>
      </div>

      <label class="setting-row">
        <span>
          <strong>保留天数</strong>
          <small>范围 1 到 3650 天；新写入的数据会按这个值计算过期时间。</small>
        </span>
        <input
          type="number"
          min="1"
          max="3650"
          step="1"
          bind:value={draftRetentionDays}
          disabled={loading || saving}
        />
      </label>

      {#if invalidRetention}
        <div class="message error"><Icon name="alertCircle" size={14} />请输入 1 到 3650 之间的整数。</div>
      {:else if error}
        <div class="message error"><Icon name="alertCircle" size={14} />{error}</div>
      {:else if savedAt}
        <div class="message success"><Icon name="checkCircle" size={14} />已保存于 {savedAt}</div>
      {/if}

      <div class="actions">
        <button class="secondary-btn" onclick={() => (draftRetentionDays = String(retentionDays))} disabled={!dirty || saving}>
          撤销
        </button>
        <button class="primary-btn" onclick={saveSettings} disabled={!dirty || invalidRetention || loading || saving}>
          <Icon name="check" size={14} color="#fff" />{saving ? "保存中" : "保存设置"}
        </button>
      </div>
    </div>
  </div>
</section>

<style>
  .settings {
    display: flex;
    flex: 1;
    overflow: hidden;
    background: var(--bg);
  }

  aside {
    width: 200px;
    flex-shrink: 0;
    padding: 16px 8px;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .title {
    padding: 0 8px 10px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .6px;
  }

  aside button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 9px;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }

  aside button.selected {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .main {
    flex: 1;
    overflow: auto;
    padding: 28px 32px;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--text-1);
    font-size: 18px;
  }

  header p,
  .section-head p,
  .setting-row small {
    color: var(--text-3);
    font-size: 12px;
  }

  .profile-panel,
  .section {
    max-width: 760px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }

  .profile-panel {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    margin-bottom: 14px;
  }

  .profile-panel strong,
  .profile-panel span {
    display: block;
  }

  .profile-panel strong {
    color: var(--text-1);
    font-size: 14px;
  }

  .profile-panel span {
    margin-top: 2px;
    color: var(--text-3);
    font-size: 12px;
  }

  .section {
    padding: 18px;
  }

  .section-head {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  h3 {
    margin-bottom: 4px;
    color: var(--text-1);
    font-size: 15px;
  }

  .status {
    flex-shrink: 0;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--success-bg);
    color: var(--success);
    font-size: 11px;
    font-weight: 650;
  }

  .status.dirty {
    background: var(--warning-bg);
    color: var(--warning);
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 18px 0;
  }

  .setting-row span {
    min-width: 0;
  }

  .setting-row strong {
    display: block;
    margin-bottom: 4px;
    color: var(--text-1);
    font-size: 13px;
  }

  .setting-row input {
    width: 120px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-1);
    outline: none;
  }

  .setting-row input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  .message {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 7px;
    font-size: 12px;
  }

  .message.error {
    background: var(--error-bg);
    color: var(--error);
  }

  .message.success {
    background: var(--success-bg);
    color: var(--success);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .actions button,
  header button {
    padding: 8px 12px;
  }

  button:disabled,
  input:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  @media (max-width: 760px) {
    aside {
      display: none;
    }

    .main {
      padding: 20px;
    }

    .setting-row {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
    }

    .setting-row input {
      width: 100%;
    }
  }
</style>
