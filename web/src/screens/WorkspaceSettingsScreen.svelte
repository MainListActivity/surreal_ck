<script lang="ts">
  import { onMount } from "svelte";
  import { AlertCircle, RefreshCw, Save, ShieldCheck, Trash2, UserPlus } from "@lucide/svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import {
    addMember,
    loadMembers,
    removeMember,
    updateMemberRole,
    type WorkspaceMember,
  } from "../lib/members-data";
  import { isWorkspaceAdmin as isWorkspaceAdminFn } from "../lib/permissions.svelte";
  import { renameWorkspace } from "../lib/workspace-meta-data";
  import { getSurreal } from "../lib/surreal";
  import {
    getConnectionState,
    getCurrentUser,
    getCurrentWorkspace,
    setCurrentWorkspaceName,
  } from "../lib/workspace-store.svelte";

  const connectionState = $derived(getConnectionState());
  const workspace = $derived(getCurrentWorkspace());
  const currentUser = $derived(getCurrentUser());
  const canManage = $derived(isWorkspaceAdminFn());
  const workspaceSlug = $derived(workspace?.slug ?? "");

  let members = $state<WorkspaceMember[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let workspaceNameDraft = $state("");
  let syncedWorkspaceSlug = $state("");
  let syncedWorkspaceName = $state("");
  let renameWriting = $state(false);
  let renameError = $state("");
  let renameOk = $state("");
  let emailDraft = $state("");
  let displayNameDraft = $state("");
  let roleDraft = $state<"participant" | "admin">("participant");
  let writing = $state(false);
  let actionError = $state("");
  let actionOk = $state("");
  let loadedSlug = $state("");

  const workspaceOriginalName = $derived((workspace?.name ?? "").trim());
  const trimmedWorkspaceName = $derived(workspaceNameDraft.trim());
  const workspaceNameDirty = $derived(trimmedWorkspaceName !== workspaceOriginalName);
  const canSaveWorkspaceName = $derived(
    canManage && !renameWriting && trimmedWorkspaceName.length > 0 && workspaceNameDirty && workspaceSlug !== "",
  );
  const canAdd = $derived(canManage && !writing && emailDraft.trim().length > 0 && workspaceSlug !== "");

  onMount(() => {
    if (connectionState === "open" && workspaceSlug) {
      loadedSlug = workspaceSlug;
      void refresh();
    }
  });

  $effect(() => {
    if (connectionState !== "open" || !workspaceSlug || loadedSlug === workspaceSlug) return;
    loadedSlug = workspaceSlug;
    void refresh();
  });

  $effect(() => {
    const nextSlug = workspace?.slug ?? "";
    const nextName = workspace?.name ?? "";
    if (nextSlug === syncedWorkspaceSlug && nextName === syncedWorkspaceName) return;
    syncedWorkspaceSlug = nextSlug;
    syncedWorkspaceName = nextName;
    workspaceNameDraft = nextName;
    renameError = "";
    renameOk = "";
  });

  async function refresh() {
    loading = true;
    loadError = "";
    try {
      members = await loadMembers(getSurreal());
    } catch (err) {
      members = [];
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function submitWorkspaceName() {
    if (!canSaveWorkspaceName) return;
    renameWriting = true;
    renameError = "";
    renameOk = "";
    const result = await renameWorkspace(workspaceSlug, workspaceNameDraft);
    renameWriting = false;
    if (!result.ok) {
      renameError = result.message;
      return;
    }
    workspaceNameDraft = result.name;
    syncedWorkspaceName = result.name;
    setCurrentWorkspaceName(result.name);
    renameOk = "已保存";
  }

  async function submitMember() {
    if (!canAdd) return;
    writing = true;
    actionError = "";
    actionOk = "";
    const result = await addMember(workspaceSlug, {
      email: emailDraft,
      displayName: displayNameDraft,
      isAdmin: roleDraft === "admin",
    });
    writing = false;
    if (!result.ok) {
      actionError = result.message;
      return;
    }
    emailDraft = "";
    displayNameDraft = "";
    roleDraft = "participant";
    actionOk = "已添加";
    await refresh();
  }

  function isSelf(member: WorkspaceMember): boolean {
    return currentUser?.email !== undefined && currentUser.email === member.email;
  }

  async function changeRole(member: WorkspaceMember, isAdmin: boolean) {
    if (writing || member.isAdmin === isAdmin) return;
    if (isSelf(member) && !globalThis.confirm("确认修改你自己的管理员权限？")) return;
    writing = true;
    actionError = "";
    actionOk = "";
    const result = await updateMemberRole(workspaceSlug, member.id, isAdmin);
    writing = false;
    if (!result.ok) {
      actionError = result.message;
      return;
    }
    actionOk = "已更新";
    await refresh();
  }

  async function remove(member: WorkspaceMember) {
    if (writing) return;
    const message = isSelf(member) ? "确认移除你自己？" : `确认移除 ${member.email}？`;
    if (!globalThis.confirm(message)) return;
    writing = true;
    actionError = "";
    actionOk = "";
    const result = await removeMember(workspaceSlug, member.id);
    writing = false;
    if (!result.ok) {
      actionError = result.message;
      return;
    }
    actionOk = "已移除";
    await refresh();
  }

  function roleLabel(isAdmin: boolean): string {
    return isAdmin ? "管理员" : "成员";
  }

  function workspaceRoleLabel(role: string | undefined): string {
    if (role === "admin") return "管理员";
    if (role === "participant") return "成员";
    if (role === "employee") return "虚拟员工";
    return role || "未知";
  }
</script>

<section class="workspace-settings">
  <header class="page-head">
    <div>
      <h1>工作区设置</h1>
      <p>{workspace?.name ?? workspace?.slug ?? "当前工作区"}</p>
    </div>
    <button type="button" class="ghost-btn" disabled={loading} onclick={() => void refresh()}>
      <RefreshCw size={15} />刷新
    </button>
  </header>

  <section class="settings-section" aria-label="基本信息">
    <div class="section-head">
      <div>
        <h2>基本信息</h2>
        <p>工作区名称会同步到侧栏和页面标题。</p>
      </div>
      {#if !canManage}
        <span class="readonly-badge">只读</span>
      {/if}
    </div>

    <form class="basic-form" onsubmit={(event) => { event.preventDefault(); void submitWorkspaceName(); }}>
      <label>
        <span>显示名称</span>
        <input
          type="text"
          bind:value={workspaceNameDraft}
          maxlength="80"
          readonly={!canManage}
          disabled={renameWriting}
          oninput={() => {
            renameError = "";
            renameOk = "";
          }}
        />
      </label>
      <label>
        <span>Slug</span>
        <input type="text" value={workspaceSlug || "—"} readonly />
      </label>
      <label>
        <span>当前角色</span>
        <input type="text" value={workspaceRoleLabel(workspace?.role)} readonly />
      </label>
      {#if canManage}
        <button type="submit" class="primary-btn" disabled={!canSaveWorkspaceName}>
          <Save size={15} />{renameWriting ? "保存中…" : "保存"}
        </button>
      {/if}
    </form>

    {#if renameError}
      <p class="action-msg error">{renameError}</p>
    {:else if renameOk}
      <p class="action-msg ok">{renameOk}</p>
    {/if}
  </section>

  <section class="settings-section" aria-label="成员管理">
    <div class="section-head">
      <div>
        <h2>成员管理</h2>
        <p>{members.length} 位成员</p>
      </div>
      {#if !canManage}
        <span class="readonly-badge">只读</span>
      {/if}
    </div>

    {#if canManage}
      <form class="invite-form" onsubmit={(event) => { event.preventDefault(); void submitMember(); }}>
        <label>
          <span>邮箱</span>
          <input
            type="email"
            bind:value={emailDraft}
            placeholder="name@example.com"
            autocomplete="off"
            disabled={writing}
            oninput={() => {
              actionError = "";
              actionOk = "";
            }}
          />
        </label>
        <label>
          <span>显示名称</span>
          <input
            type="text"
            bind:value={displayNameDraft}
            placeholder="可选"
            maxlength="120"
            disabled={writing}
            oninput={() => {
              actionError = "";
              actionOk = "";
            }}
          />
        </label>
        <label>
          <span>角色</span>
          <select bind:value={roleDraft} disabled={writing}>
            <option value="participant">成员</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <button type="submit" class="primary-btn" disabled={!canAdd}>
          <UserPlus size={15} />{writing ? "处理中…" : "添加成员"}
        </button>
      </form>
    {/if}

    {#if actionError}
      <p class="action-msg error">{actionError}</p>
    {:else if actionOk}
      <p class="action-msg ok">{actionOk}</p>
    {/if}

    {#if loadError}
      <EmptyState
        icon={AlertCircle}
        title="成员加载失败"
        desc={loadError}
        action="重试"
        onAction={() => void refresh()}
      />
    {:else if loading}
      <div class="loading">加载中…</div>
    {:else}
      <div class="member-list">
        <div class="list-head" aria-hidden="true">
          <span>成员</span>
          <span>角色</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {#each members as member (member.id)}
          <div class="member-row">
            <div class="member-main">
              <span class="avatar">{(member.displayName ?? member.email).slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{member.displayName ?? member.email}</strong>
                <small>{member.email}</small>
              </div>
            </div>
            <div class="role-cell">
              {#if canManage}
                <select
                  aria-label={`${member.email} 角色`}
                  value={member.isAdmin ? "admin" : "participant"}
                  disabled={writing}
                  onchange={(event) => void changeRole(member, (event.currentTarget as HTMLSelectElement).value === "admin")}
                >
                  <option value="participant">成员</option>
                  <option value="admin">管理员</option>
                </select>
              {:else}
                <span class="role-pill"><ShieldCheck size={13} />{roleLabel(member.isAdmin)}</span>
              {/if}
            </div>
            <div class="status-cell">
              <span class:pending={member.pending}>{member.pending ? "待加入" : "已激活"}</span>
            </div>
            <div class="actions-cell">
              {#if canManage}
                <button
                  type="button"
                  class="danger-btn"
                  disabled={writing}
                  title="移除成员"
                  aria-label={`移除 ${member.email}`}
                  onclick={() => void remove(member)}
                >
                  <Trash2 size={15} />
                </button>
              {:else}
                <span class="muted">—</span>
              {/if}
            </div>
          </div>
        {/each}
        {#if members.length === 0}
          <div class="empty-row">暂无成员</div>
        {/if}
      </div>
    {/if}
  </section>
</section>

<style>
  .workspace-settings {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 22px;
    padding: 32px;
    overflow-y: auto;
    background: var(--bg);
  }

  .page-head,
  .section-head,
  .basic-form,
  .invite-form,
  .member-row,
  .list-head {
    display: flex;
    align-items: center;
  }

  .page-head {
    justify-content: space-between;
    gap: 18px;
  }

  .page-head h1,
  .section-head h2 {
    margin: 0;
    color: var(--text-1);
  }

  .page-head h1 {
    font-size: 22px;
    font-weight: 700;
  }

  .page-head p,
  .section-head p {
    margin: 5px 0 0;
    color: var(--text-3);
    font-size: 13px;
  }

  .settings-section {
    display: flex;
    max-width: 920px;
    flex-direction: column;
    gap: 16px;
    padding: 22px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  .section-head {
    justify-content: space-between;
    gap: 16px;
  }

  .section-head h2 {
    font-size: 16px;
    font-weight: 700;
  }

  .basic-form {
    display: grid;
    grid-template-columns: minmax(240px, 1.2fr) minmax(160px, .8fr) minmax(140px, .7fr) auto;
    gap: 12px;
    align-items: end;
  }

  .invite-form {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(180px, .8fr) 140px auto;
    gap: 12px;
    align-items: end;
  }

  label {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 6px;
  }

  label span {
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
  }

  input,
  select {
    width: 100%;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text-1);
    font-size: 13px;
  }

  input:focus,
  select:focus {
    border-color: var(--primary);
    outline: none;
  }

  input[readonly] {
    color: var(--text-2);
  }

  .ghost-btn,
  .primary-btn,
  .danger-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .ghost-btn {
    height: 34px;
    gap: 7px;
    padding: 0 12px;
    border-color: var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-2);
  }

  .primary-btn {
    height: 36px;
    gap: 7px;
    padding: 0 14px;
    border-radius: 8px;
    background: var(--primary);
    color: var(--primary-foreground);
    white-space: nowrap;
  }

  .danger-btn {
    width: 32px;
    height: 32px;
    border-color: var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--danger, #e86b4f);
  }

  .ghost-btn:disabled,
  .primary-btn:disabled,
  .danger-btn:disabled,
  input:disabled,
  select:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  .readonly-badge,
  .role-pill,
  .status-cell span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
  }

  .readonly-badge {
    padding: 3px 9px;
    background: var(--bg);
    color: var(--text-3);
  }

  .role-pill {
    padding: 3px 8px;
    background: var(--primary-light);
    color: var(--brand-strong);
  }

  .action-msg {
    margin: 0;
    font-size: 13px;
  }

  .action-msg.error {
    color: var(--danger, #e86b4f);
  }

  .action-msg.ok {
    color: var(--success, #54c07b);
  }

  .loading,
  .empty-row {
    padding: 28px 0;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
  }

  .member-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  .list-head,
  .member-row {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) 150px 110px 70px;
    gap: 14px;
  }

  .list-head {
    padding: 10px 14px;
    background: var(--bg);
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .8px;
    text-transform: uppercase;
  }

  .member-row {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
  }

  .member-main {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 11px;
  }

  .avatar {
    display: grid;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    place-items: center;
    border-radius: 9px;
    background: var(--primary-light);
    color: var(--brand-strong);
    font-size: 13px;
    font-weight: 800;
  }

  .member-main div {
    min-width: 0;
  }

  .member-main strong,
  .member-main small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-main strong {
    color: var(--text-1);
    font-size: 13.5px;
  }

  .member-main small,
  .muted {
    color: var(--text-3);
    font-size: 12px;
  }

  .role-cell,
  .status-cell,
  .actions-cell {
    display: flex;
    align-items: center;
  }

  .status-cell span {
    padding: 3px 8px;
    background: var(--primary-light);
    color: var(--brand-strong);
  }

  .status-cell span.pending {
    background: var(--seed-soft, #f7eadf);
    color: var(--seed, #cc6b3a);
  }

  .actions-cell {
    justify-content: flex-end;
  }

  @media (max-width: 860px) {
    .basic-form,
    .invite-form {
      grid-template-columns: 1fr;
    }

    .list-head {
      display: none;
    }

    .member-row {
      grid-template-columns: 1fr;
      gap: 10px;
    }

    .actions-cell {
      justify-content: flex-start;
    }
  }
</style>
