<script lang="ts">
  import { onMount } from "svelte";
  import { ShieldCheck, UserPlus, X } from "@lucide/svelte";
  import {
    createInviteMemberController,
    initialInviteMemberState,
  } from "../lib/invite-member";
  import { getSurreal } from "../lib/surreal";
  import { getCurrentWorkspace } from "../lib/workspace-store.svelte";

  let { onclose }: { onclose?: () => void } = $props();

  const controller = createInviteMemberController();
  const workspace = $derived(getCurrentWorkspace());
  const workspaceSlug = $derived(workspace?.slug ?? "");

  let form = $state(initialInviteMemberState());

  onMount(() => {
    void (async () => {
      form = await controller.reloadMembers(form, getSurreal());
    })();
  });

  async function submit() {
    form = await controller.submit(form, workspaceSlug, getSurreal());
  }

  function roleLabel(isAdmin: boolean): string {
    return isAdmin ? "管理员" : "成员";
  }
</script>

<div class="overlay" role="presentation" onclick={() => !form.writing && onclose?.()}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="invite-member-title"
    onclick={(event) => event.stopPropagation()}
  >
    <header class="header">
      <div class="title-wrap">
        <UserPlus size={18} />
        <h2 id="invite-member-title">邀请协作者</h2>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭" disabled={form.writing} onclick={() => onclose?.()}>
        <X size={16} />
      </button>
    </header>

    <p class="hint">
      输入对方邮箱将其加入「{workspace?.name ?? workspaceSlug}」。新成员首次登录后自动激活；仅工作区管理员可添加成员。
    </p>

    <form class="invite-form" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>
        <span>邮箱</span>
        <input
          type="email"
          bind:value={form.email}
          placeholder="name@example.com"
          autocomplete="off"
          disabled={form.writing}
          oninput={() => {
            form.error = null;
            form.notice = null;
          }}
        />
      </label>
      <label>
        <span>显示名称</span>
        <input
          type="text"
          bind:value={form.displayName}
          placeholder="可选"
          maxlength="120"
          disabled={form.writing}
        />
      </label>
      <label>
        <span>角色</span>
        <select bind:value={form.role} disabled={form.writing}>
          <option value="participant">成员</option>
          <option value="admin">管理员</option>
        </select>
      </label>
      <button
        type="submit"
        class="primary"
        disabled={form.writing || form.email.trim().length === 0 || workspaceSlug === ""}
      >
        <UserPlus size={15} />{form.writing ? "处理中…" : "添加成员"}
      </button>
    </form>

    {#if form.error}
      <div class="status error" role="alert">{form.error}</div>
    {:else if form.notice}
      <div class="status ok" role="status">{form.notice}</div>
    {/if}

    <section class="members" aria-label="当前成员">
      <h3>当前成员</h3>
      {#if form.membersError}
        <p class="status error" role="alert">{form.membersError}</p>
      {:else if form.membersLoading}
        <p class="empty">加载中…</p>
      {:else}
        <div class="list">
          {#each form.members as member (member.id)}
            <div class="row">
              <div>
                <strong>{member.displayName ?? member.email}</strong>
                <small>{member.email}</small>
              </div>
              <span class="badge">
                <ShieldCheck size={12} />{roleLabel(member.isAdmin)}{member.pending ? " · 待加入" : ""}
              </span>
            </div>
          {:else}
            <p class="empty">暂无成员</p>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    display: grid;
    place-items: center;
    z-index: 80;
    padding: 24px;
  }
  .dialog {
    width: min(560px, 100%);
    max-height: min(80vh, 720px);
    overflow: auto;
    background: var(--surface, #fff);
    color: var(--text-1, #0f172a);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
    padding: 20px 22px 22px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  h3 {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-2, #475569);
  }
  .hint {
    color: var(--text-2, #475569);
    font-size: 0.9rem;
  }
  .invite-form {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(140px, .8fr) 110px auto;
    gap: 10px;
    align-items: end;
    margin-top: 8px;
  }
  label {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 6px;
  }
  label span {
    color: var(--text-2, #475569);
    font-size: 0.75rem;
    font-weight: 600;
  }
  input,
  select {
    width: 100%;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 8px;
    background: var(--bg, #f8fafc);
    color: var(--text-1, #0f172a);
    font-size: 0.85rem;
  }
  input:focus,
  select:focus {
    border-color: var(--primary, #0f766e);
    outline: none;
  }
  .members {
    display: grid;
    gap: 10px;
    margin-top: 16px;
  }
  .list {
    display: grid;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 12px;
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 12px;
  }
  .row small {
    display: block;
    color: var(--text-2, #64748b);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    color: #0f766e;
    white-space: nowrap;
  }
  .empty {
    color: var(--text-2, #64748b);
    margin: 0;
  }
  .status {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 0.85rem;
  }
  .status.error {
    background: #fef2f2;
    color: #b91c1c;
  }
  .status.ok {
    background: #ecfdf5;
    color: #047857;
  }
  button {
    border: 0;
    border-radius: 10px;
    padding: 8px 12px;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .primary {
    background: var(--primary, #0f766e);
    color: #fff;
    white-space: nowrap;
  }
  .icon-btn {
    background: transparent;
    padding: 6px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
