<script lang="ts">
  import { AlertCircle } from "@lucide/svelte";
  import Avatar from "../components/Avatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { loadCurrentUser, saveDisplayName, type CurrentUserProfile } from "../lib/profile-data";
  import { getSurreal } from "../lib/surreal";
  import { getConnectionState } from "../lib/workspace-store.svelte";
  import { setCurrentUserDisplayName } from "../lib/workspace-store.svelte";

  // 个人中心身份卡：当前 workspace db 的个人账户页。唯一可写字段 display_name；
  // email / 角色只读，头像为字母头像（不上传）。读写直连 SurrealDB，db 为 SSOT。
  const connectionState = $derived(getConnectionState());

  let profile = $state<CurrentUserProfile | null>(null);
  let loading = $state(true);
  let loadFailed = $state(false);
  let nameDraft = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let savedFlash = $state(false);

  const role = $derived(profile?.isAdmin ? "管理员" : "成员");
  const avatarName = $derived(nameDraft.trim() || profile?.email || "我");
  const dirty = $derived(profile !== null && nameDraft.trim() !== (profile.displayName ?? "").trim());

  $effect(() => {
    if (connectionState !== "open") return;
    void load();
  });

  async function load() {
    loading = true;
    loadFailed = false;
    try {
      const next = await loadCurrentUser(getSurreal());
      if (!next) {
        loadFailed = true;
        profile = null;
        return;
      }
      profile = next;
      nameDraft = next.displayName ?? "";
      // db 是 SSOT：把读回的 display_name 同步进 store，侧栏头像随之显示真实昵称。
      setCurrentUserDisplayName(next.displayName);
    } catch {
      loadFailed = true;
      profile = null;
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!profile || saving) return;
    saving = true;
    saveError = "";
    savedFlash = false;
    const result = await saveDisplayName(getSurreal(), profile.id, nameDraft);
    saving = false;
    if (!result.ok) {
      saveError = result.message;
      return;
    }
    profile = { ...profile, displayName: result.displayName };
    nameDraft = result.displayName ?? "";
    setCurrentUserDisplayName(result.displayName);
    savedFlash = true;
  }
</script>

<section class="profile">
  {#if loadFailed}
    <EmptyState
      icon={AlertCircle}
      title="无法定位当前用户"
      desc="未能在当前工作区找到你的账户记录。请重新进入工作区，或联系管理员。"
    />
  {:else if loading || !profile}
    <div class="loading">加载中…</div>
  {:else}
    <header class="profile-head">
      <Avatar name={avatarName} size={64} />
      <div class="head-meta">
        <h1>{nameDraft.trim() || "未命名"}</h1>
        <span class="role-badge">{role}</span>
      </div>
    </header>

    <div class="card">
      <label class="field">
        <span class="field-label">显示名称</span>
        <input
          type="text"
          bind:value={nameDraft}
          placeholder="留空将使用邮箱首字母"
          maxlength="120"
          oninput={() => {
            saveError = "";
            savedFlash = false;
          }}
        />
        <span class="field-hint">其他成员看到的名字，可留空。</span>
      </label>

      <div class="field">
        <span class="field-label">邮箱</span>
        <div class="readonly-value">{profile.email}</div>
        <span class="field-hint">由身份提供方管理，不可在此修改。</span>
      </div>

      <div class="field">
        <span class="field-label">角色</span>
        <div class="readonly-value">{role}</div>
        <span class="field-hint">在当前工作区的权限角色。</span>
      </div>

      {#if saveError}
        <p class="save-error">{saveError}</p>
      {:else if savedFlash}
        <p class="save-ok">已保存</p>
      {/if}

      <div class="actions">
        <button class="primary-btn" disabled={!dirty || saving} onclick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  {/if}
</section>

<style>
  .profile {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 24px;
    padding: 32px;
    overflow-y: auto;
    background: var(--bg);
  }
  .loading {
    color: var(--text-3);
    padding: 24px 0;
  }
  .profile-head {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .head-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head-meta h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text-1);
  }
  .role-badge {
    align-self: flex-start;
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--bg-2, rgba(0, 0, 0, 0.05));
    color: var(--text-2);
    font-size: 12px;
  }
  .card {
    display: flex;
    max-width: 480px;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
    border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
    border-radius: 12px;
    background: var(--surface, #fff);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .field-hint {
    font-size: 12px;
    color: var(--text-3);
  }
  .field input {
    padding: 8px 10px;
    border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
    border-radius: 8px;
    background: var(--bg);
    color: var(--text-1);
    font-size: 14px;
  }
  .field input:focus {
    border-color: var(--ring, #5b78f6);
    outline: none;
  }
  .readonly-value {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--bg-2, rgba(0, 0, 0, 0.04));
    color: var(--text-2);
    font-size: 14px;
  }
  .save-error {
    margin: 0;
    color: var(--danger, #e86b4f);
    font-size: 13px;
  }
  .save-ok {
    margin: 0;
    color: var(--success, #54c07b);
    font-size: 13px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .primary-btn {
    padding: 8px 18px;
    border: none;
    border-radius: 8px;
    background: var(--primary, #5b78f6);
    color: var(--primary-foreground, #fff);
    font-size: 14px;
    cursor: pointer;
  }
  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
